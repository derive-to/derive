import { describe, expect, it } from "vitest"
import { anonApp, as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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
