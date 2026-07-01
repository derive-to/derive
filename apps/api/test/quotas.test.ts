import { describe, expect, it } from "vitest"
import { as, bearer, pub, quotaApp, type TestUser } from "./helpers"

describe("quotas: per-workspace storage caps (C4b)", () => {
  it("persists each version's byte size and meters the workspace total", async () => {
    const { app, meta: m } = quotaApp("quota-meter", {})
    const a = await (await pub(app, "hello")).json() // 5 bytes
    await pub(app, "worldwide", {}, a.short_id) // +9 bytes on v2
    expect(await m.storageBytes("default")).toBe(14)
    // Republishing identical bytes is content-addressed to the same blob, so the
    // meter dedups it — still 14, not 19.
    await pub(app, "hello", {}, a.short_id)
    expect(await m.storageBytes("default")).toBe(14)
    m.close()
  })

  it("rejects an upload that would exceed maxBytes with 413, keeps the under-limit one", async () => {
    const { app, meta: m } = quotaApp("quota-bytes", { maxBytes: 20 })
    expect((await pub(app, "0123456789")).status).toBe(201) // 10 ≤ 20
    const over = await pub(app, "0123456789AB") // total 22 > 20
    expect(over.status).toBe(413)
    expect((await over.json()).error).toMatch(/storage quota/)
    expect(await m.storageBytes("default")).toBe(10) // the rejected upload stored nothing
    m.close()
  })

  it("caps the number of artifacts (409), but still allows new versions of existing ones", async () => {
    const { app } = quotaApp("quota-count", { maxArtifacts: 2 })
    const a1 = await (await pub(app, "one")).json()
    expect((await pub(app, "two")).status).toBe(201)
    const third = await pub(app, "three")
    expect(third.status).toBe(409)
    expect((await third.json()).error).toMatch(/artifact quota/)
    // Republishing an existing artifact doesn't create a new one — still allowed.
    expect((await pub(app, "one-v2", {}, a1.short_id)).status).toBe(201)
  })
})

describe("rate limits: per-actor write throttles (C4b)", () => {
  it("throttles a flood of publishes from one caller with 429 + Retry-After", async () => {
    const { app } = quotaApp("rl-publish", { rateLimit: true, publishRate: 2 })
    expect((await pub(app, "a")).status).toBe(201)
    expect((await pub(app, "b")).status).toBe(201)
    const blocked = await pub(app, "c")
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("Retry-After")).toBeTruthy()
  })

  it("throttles comments independently of publishes", async () => {
    const { app } = quotaApp("rl-comment", { rateLimit: true, commentRate: 2 })
    const a = await (await pub(app, "doc")).json()
    const comment = () =>
      app.request(`/v1/artifacts/${a.short_id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer("tok") },
        body: JSON.stringify({ body_md: "hi", author: "x" }),
      })
    expect((await comment()).status).toBe(201)
    expect((await comment()).status).toBe(201)
    expect((await comment()).status).toBe(429)
  })

  it("throttles password-unlock attempts with a tight dedicated cap (5 per 5 min)", async () => {
    const { app } = quotaApp("rl-unlock", { rateLimit: true })
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>x</h1>")]), "x.html")
    form.append("visibility", "password")
    form.append("password", "hunter2")
    const a = await (
      await app.request("/v1/artifacts", { method: "POST", body: form, headers: bearer("tok") })
    ).json()
    // Anonymous wrong-password attempts: the limiter runs before the password
    // check, so each counts. Five are allowed (401 wrong-password), the 6th 429s —
    // far below the lenient 120/min global write cap this used to share.
    const attempt = () =>
      app.request(`/v1/artifacts/${a.short_id}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      })
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401)
    const blocked = await attempt()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("Retry-After")).toBeTruthy()
  })

  it("keys the limit by identity — one user hitting the cap doesn't block another", async () => {
    const amy: TestUser = { id: "u_amy", email: "amy@derive.test", name: "Amy" }
    const ben: TestUser = { id: "u_ben", email: "ben@derive.test", name: "Ben" }
    const { app } = quotaApp("rl-actor", { rateLimit: true, publishRate: 1 }, [amy, ben])
    // Amy provisions as owner (first member); Ben joins as the default editor.
    await app.request("/v1/me", { headers: as(amy.email) })
    await app.request("/v1/me", { headers: as(ben.email) })
    expect((await pub(app, "a1", {}, undefined, as(amy.email))).status).toBe(201)
    expect((await pub(app, "a2", {}, undefined, as(amy.email))).status).toBe(429) // Amy capped
    expect((await pub(app, "b1", {}, undefined, as(ben.email))).status).toBe(201) // Ben unaffected
  })
})

describe("multi-tenant hardening: per-org quotas + cross-org isolation", () => {
  const amy: TestUser = { id: "u_mt_amy", email: "mtamy@derive.test", name: "Amy" }
  const ben: TestUser = { id: "u_mt_ben", email: "mtben@derive.test", name: "Ben" }

  it("storage quota is per-workspace — one org filling up does NOT block another", async () => {
    const { app } = quotaApp("mt-quota", { maxBytes: 12 }, [amy, ben])
    await app.request("/v1/me", { headers: as(amy.email) }) // provision Amy's workspace
    await app.request("/v1/me", { headers: as(ben.email) }) // provision Ben's workspace
    // Amy fills her own 12-byte cap.
    expect((await pub(app, "0123456789", {}, undefined, as(amy.email))).status).toBe(201) // 10
    expect((await pub(app, "ABCDE", {}, undefined, as(amy.email))).status).toBe(413) // +5 > 12
    // Ben's workspace meter is independent — before the per-org fix this 413'd
    // because the meter summed every workspace's bytes against one global cap.
    expect((await pub(app, "0123456789", {}, undefined, as(ben.email))).status).toBe(201)
  })

  it("an artifact in one org with 'org' visibility is 404 to a member of another org", async () => {
    const { app } = quotaApp("mt-isolation", {}, [amy, ben])
    await app.request("/v1/me", { headers: as(amy.email) })
    await app.request("/v1/me", { headers: as(ben.email) })
    const a = await (
      await pub(app, "amy's private doc", { visibility: "org" }, undefined, as(amy.email))
    ).json()
    // Amy sees her own artifact; Ben (different workspace) cannot, by id.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(amy.email) })).status,
    ).toBe(200)
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}/content`, { headers: as(ben.email) })).status,
    ).toBe(404)
  })
})
