import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The fill-with-your-work pair on a derived copy. GET /v1/artifacts/:id/fill returns
// the copyable prompt; POST delivers the identical instruction (fillInstruction is
// the single source) to an agent's pull inbox, the rework-route pattern.

const owner: TestUser = {
  id: "u_fill_own",
  email: "fillown@derive.test",
  name: "Owner",
  username: "fillown",
}
const editor: TestUser = {
  id: "u_fill_ed",
  email: "filled@derive.test",
  name: "Ed",
  username: "filled",
}

const { app, meta } = makeAuthedApp("fill", [owner, editor], "editor")

// A template + a copy derived from it through the real route, as the editor.
const derive = async () => {
  const src = await (
    await publishAs(app, "<h1>Weekly deck</h1>", { title: "Weekly deck" }, as(owner.email))
  ).json()
  const copy = await (
    await app.request(`/v1/artifacts/${src.short_id}/use`, {
      method: "POST",
      headers: as(editor.email),
    })
  ).json()
  return { src: src.short_id as string, copy: copy.short_id as string }
}

const addAgent = async (name: string) =>
  (await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
  ).json()) as { id: string; name: string; token: string }

const getFill = (shortId: string, note?: string, who = editor.email) =>
  app.request(`/v1/artifacts/${shortId}/fill${note ? `?note=${encodeURIComponent(note)}` : ""}`, {
    headers: as(who),
  })
const postFill = (shortId: string, body: Record<string, unknown> = {}, who = editor.email) =>
  app.request(`/v1/artifacts/${shortId}/fill`, jsonAs(as(who), body))

describe("GET /fill — the copyable prompt", () => {
  it("names the copy and the template, licenses adaptation, and appends the note", async () => {
    const { src, copy } = await derive()
    const res = await getFill(copy, "Week 32 — skip the hiring section")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toEqual({ short_id: src, title: "Weekly deck" })
    expect(body.prompt).toContain(src)
    expect(body.prompt).toContain(copy)
    expect(body.prompt).toContain("starting point")
    expect(body.prompt).toContain("never invent a plausible value")
    expect(body.prompt).toContain("From the requester: Week 32 — skip the hiring section")
    // No Brandprint is set up in this workspace — the brand line stays out.
    expect(body.prompt).not.toContain("derive://brandprint")
  })

  it("409s notDerived for an artifact with no template lineage", async () => {
    const plain = await (await publishAs(app, "# Doc", {}, as(owner.email))).json()
    const res = await getFill(plain.short_id)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("notDerived")
  })

  it("409s sourceGone when the template was taken down", async () => {
    const { src, copy } = await derive()
    const srcRow = await meta.getByShortId(src)
    await meta.setArtifactRemoved(srcRow?.id as string, new Date().toISOString())
    const res = await getFill(copy)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("sourceGone")
  })
})

describe("POST /fill — the one-click ask", () => {
  it("lands the same instruction in the agent's inbox, once", async () => {
    const { src, copy } = await derive()
    const agent = await addAgent("Filler")
    const res = await postFill(copy, { note: "payments team only" })
    expect(res.status).toBe(201)

    const inbox = (await (
      await app.request("/v1/agent/inbox", { headers: bearer(agent.token) })
    ).json()) as { mentions: { body: string }[] }
    const body = inbox.mentions[0]?.body ?? ""
    expect(body).toContain(src)
    expect(body).toContain(copy)
    expect(body).toContain("From the requester: payments team only")

    // The pull queue holds one ask per (agent, artifact) until the agent acks.
    const again = await postFill(copy)
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe("alreadyQueued")
  })

  it("409s needsAgent when nobody can be asked, notDerived off-lineage", async () => {
    const lone = makeAuthedApp("fill-noagent", [owner, editor], "editor")
    const src = await (
      await publishAs(lone.app, "<h1>T</h1>", { title: "T" }, as(owner.email))
    ).json()
    const copy = await (
      await lone.app.request(`/v1/artifacts/${src.short_id}/use`, {
        method: "POST",
        headers: as(editor.email),
      })
    ).json()
    const res = await lone.app.request(
      `/v1/artifacts/${copy.short_id}/fill`,
      jsonAs(as(editor.email), {}),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("needsAgent")

    const plain = await (await publishAs(app, "# P", {}, as(owner.email))).json()
    const off = await postFill(plain.short_id)
    expect(off.status).toBe(409)
    expect((await off.json()).code).toBe("notDerived")
  })
})
