import { describe, expect, it } from "vitest"
import { anonApp, as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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

describe("bug-hunt cleanup fixes", () => {
  const owner: TestUser = { id: "u_cl_owner", email: "owner-cl@derive.test", name: "Owner CL" }

  // B-017: comment body is length-capped.
  it("B-017: rejects an over-long comment body (max 10000)", async () => {
    const { app } = makeAuthedApp("cl-comment", [owner])
    const { short_id } = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    const tooLong = await app.request(
      `/v1/artifacts/${short_id}/comments`,
      jsonAs(as(owner.email), { body_md: "x".repeat(10_001), anchor: null }),
    )
    expect(tooLong.status).toBe(400)
    const ok = await app.request(
      `/v1/artifacts/${short_id}/comments`,
      jsonAs(as(owner.email), { body_md: "x".repeat(9_000), anchor: null }),
    )
    expect(ok.status).toBe(201)
  })

  // B-016: a taken-down artifact's detail is a minimal tombstone — no title / author /
  // version metadata, even to a member.
  it("B-016: takedown returns a minimal tombstone (no title/versions), content 410s", async () => {
    const { app } = makeAuthedApp("cl-takedown", [owner])
    const { short_id } = await (
      await publishAs(
        app,
        "<h1>secret</h1>",
        { title: "Sensitive Title", visibility: "public" },
        as(owner.email),
      )
    ).json()
    const td = await app.request(`/v1/artifacts/${short_id}/takedown`, jsonAs(as(owner.email), {}))
    expect(td.status).toBe(200)
    const detail = await (
      await app.request(`/v1/artifacts/${short_id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.removed).toBe(true)
    expect(detail.title).toBeNull() // the (often-abusive) title is not retained
    expect(detail.versions).toEqual([]) // no author / sha256 / message metadata
    expect(detail.url).not.toContain("sensitive-title") // no title in the slug
    const content = await app.request(`/v1/artifacts/${short_id}/content`)
    expect(content.status).toBe(410) // tombstone
  })

  // B-006: OIDC discovery returns JSON metadata (previously fell through to the SPA shell).
  it("B-006: /.well-known/openid-configuration serves OIDC metadata", async () => {
    const res = await anonApp.request("/.well-known/openid-configuration")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const meta = await res.json()
    expect(meta.issuer).toBeTruthy()
    expect(meta.jwks_uri).toBeTruthy()
    expect(meta.subject_types_supported).toContain("public")
    expect(meta.id_token_signing_alg_values_supported).toContain("EdDSA")
  })
})
