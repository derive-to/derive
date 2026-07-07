import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("moderation: report → takedown (410) → reinstate + audit (C4a)", () => {
  const owner: TestUser = { id: "u_mod_own", email: "modown@derive.test", name: "Owner" }
  const dev: TestUser = { id: "u_mod_dev", email: "moddev@derive.test", name: "Dev" }
  const { app } = makeAuthedApp("moderation", [owner, dev], "commenter")
  let shortId: string

  it("anyone can report a public artifact; reason is required", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    // Link-visible on purpose: the takedown assertions below read anonymously
    // (the 410 must outrank the read gate on a reachable artifact).
    shortId = (
      await (
        await publishAs(app, "<h1>spammy</h1>", { visibility: "public" }, as(owner.email))
      ).json()
    ).short_id
    // Anonymous (no session) can't report at all — refused at the door.
    expect(
      (await app.request(`/v1/artifacts/${shortId}/report`, jsonAs({}, { reason: "x" }))).status,
    ).toBe(403)
    // Signed in but no reason → 400.
    expect(
      (await app.request(`/v1/artifacts/${shortId}/report`, jsonAs(as(dev.email), {}))).status,
    ).toBe(400)
    const r = await app.request(
      `/v1/artifacts/${shortId}/report`,
      jsonAs(as(dev.email), { reason: "phishing", detail: "fake login page" }),
    )
    expect(r.status).toBe(201)
  })

  it("the report shows in the owner's queue; a commenter can't see it", async () => {
    expect((await app.request("/v1/reports", { headers: as(dev.email) })).status).toBe(403)
    const q = await (await app.request("/v1/reports", { headers: as(owner.email) })).json()
    expect(q.open).toBe(1)
    expect(q.reports[0]).toMatchObject({ artifact_short_id: shortId, reason: "phishing" })
  })

  it("takedown 410s the content everywhere, keeps the record, and clears the report", async () => {
    expect(
      (await app.request(`/v1/artifacts/${shortId}/takedown`, jsonAs(as(dev.email), {}))).status,
    ).toBe(403)
    const td = await app.request(`/v1/artifacts/${shortId}/takedown`, jsonAs(as(owner.email), {}))
    expect(td.status).toBe(200)

    // Content is gone (410) on every serving surface; the record survives.
    expect((await app.request(`/v1/artifacts/${shortId}/content`)).status).toBe(410)
    expect((await app.request(`/raw/${shortId}/v/1/index.html`)).status).toBe(410)
    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.removed).toBe(true)
    // The open report was actioned by the takedown.
    expect(
      (await (await app.request("/v1/reports", { headers: as(owner.email) })).json()).open,
    ).toBe(0)
  })

  it("reinstate restores serving", async () => {
    const re = await app.request(`/v1/artifacts/${shortId}/reinstate`, jsonAs(as(owner.email), {}))
    expect(re.status).toBe(200)
    expect((await app.request(`/raw/${shortId}/v/1/index.html`)).status).toBe(200)
  })

  it("the audit log records every moderation action", async () => {
    const { audit } = await (await app.request("/v1/audit", { headers: as(owner.email) })).json()
    const actions = audit.map((a: { action: string }) => a.action)
    expect(actions).toContain("report")
    expect(actions).toContain("takedown")
    expect(actions).toContain("reinstate")
  })
})
