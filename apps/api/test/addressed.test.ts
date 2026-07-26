import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, proposeAs, publishAs, type TestUser } from "./helpers"

// The `addressed` state machine: a proposal that cites comment threads flips them
// to `addressed` (pending review); approving resolves them, withdrawing or
// requesting changes reopens them.

const owner: TestUser = { id: "u_ao", email: "ao@derive.test", name: "Ao" }
const ed: TestUser = { id: "u_ae", email: "ae@derive.test", name: "Ae" }

const stateOf = async (
  app: ReturnType<typeof makeAuthedApp>["app"],
  shortId: string,
  threadId: string,
) => {
  const list = await (
    await app.request(`/v1/artifacts/${shortId}/comments`, { headers: as(owner.email) })
  ).json()
  return list.comments.find((c: { thread_id: string }) => c.thread_id === threadId)?.state
}

const comment = async (
  app: ReturnType<typeof makeAuthedApp>["app"],
  shortId: string,
  body: string,
) => {
  const res = await app.request(
    `/v1/artifacts/${shortId}/comments`,
    jsonAs(as(owner.email), { body_md: body }),
  )
  return res.json()
}

describe("addressed: propose cites threads → pending → resolve on approve", () => {
  const { app } = makeAuthedApp("addressed-approve", [owner, ed], "editor")

  it("flips cited threads to addressed, then resolves them when the proposal is approved", async () => {
    const shortId = (
      await (await publishAs(app, "<h1>v1</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    const cm = await comment(app, shortId, "please fix the headline")
    expect(await stateOf(app, shortId, cm.thread_id)).toBe("open")

    // Propose citing the thread → it becomes addressed (pending review).
    const pr = await (
      await proposeAs(app, shortId, "<h1>v2</h1>", as(ed.email), {
        message: "fixed headline",
        addresses: cm.thread_id,
      })
    ).json()
    expect(pr.addressed).toEqual([cm.thread_id])
    expect(await stateOf(app, shortId, cm.thread_id)).toBe("addressed")
    // It's off the open to-do list while a fix is pending.
    const open = await (
      await app.request(`/v1/artifacts/${shortId}/comments?state=open`, {
        headers: as(owner.email),
      })
    ).json()
    expect(open.comments).toHaveLength(0)

    // Approve → the fix landed → the thread resolves.
    const ap = await app.request(`/v1/artifacts/${shortId}/proposals/${pr.id}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(ap.status).toBe(200)
    expect(await stateOf(app, shortId, cm.thread_id)).toBe("resolved")
  })
})

describe("addressed: reopens when the proposal doesn't land", () => {
  const { app } = makeAuthedApp("addressed-revert", [owner, ed], "editor")

  it("reopens on withdraw and on request-changes", async () => {
    const shortId = (
      await (await publishAs(app, "<h1>v1</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id

    // Withdraw path.
    const cm1 = await comment(app, shortId, "tweak intro")
    const p1 = await (
      await proposeAs(app, shortId, "<h1>v2</h1>", as(ed.email), {
        message: "intro",
        addresses: cm1.thread_id,
      })
    ).json()
    expect(await stateOf(app, shortId, cm1.thread_id)).toBe("addressed")
    await app.request(`/v1/artifacts/${shortId}/proposals/${p1.id}/withdraw`, {
      method: "POST",
      headers: as(ed.email),
    })
    expect(await stateOf(app, shortId, cm1.thread_id)).toBe("open")

    // Request-changes path.
    const cm2 = await comment(app, shortId, "trim footer")
    const p2 = await (
      await proposeAs(app, shortId, "<h1>v2b</h1>", as(ed.email), {
        message: "footer",
        addresses: cm2.thread_id,
      })
    ).json()
    expect(await stateOf(app, shortId, cm2.thread_id)).toBe("addressed")
    await app.request(`/v1/artifacts/${shortId}/proposals/${p2.id}/request-changes`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(await stateOf(app, shortId, cm2.thread_id)).toBe("open")
  })
})
