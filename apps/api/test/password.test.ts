import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { dir, meta } from "./helpers"

// Password-protected artifacts: world-reachable by URL like `link`, but the bytes
// stay gated until a visitor enters the password (then read as a viewer). Owners /
// members always see it by role.
describe("permissions: password-protected artifacts", () => {
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "s3cret",
  })
  const owner = { authorization: "Bearer s3cret" }
  const pub = (visibility: string, password?: string) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>secret</h1>")]), "s.html")
    form.append("visibility", visibility)
    if (password) form.append("password", password)
    return app.request("/v1/artifacts", { method: "POST", body: form, headers: owner })
  }
  const unlock = (id: string, password: string) =>
    app.request(`/v1/artifacts/${id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    })
  let shortId = ""

  it("rejects `password` visibility published without a password", async () => {
    expect((await pub("password")).status).toBe(400)
  })

  it("publishes a password artifact; the owner reads it, anonymous is locked (401)", async () => {
    const res = await pub("password", "hunter2")
    expect(res.status).toBe(201)
    shortId = (await res.json()).short_id
    // The owner (token) always reads it by role.
    expect((await app.request(`/v1/artifacts/${shortId}`, { headers: owner })).status).toBe(200)
    // Anonymous: lockable, not hidden — prompt (401), and the bytes stay gated.
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(401)
    expect((await app.request(`/v1/artifacts/${shortId}/content`)).status).toBe(404)
  })

  it("rejects the wrong password, then unlocks with the right one via cookie", async () => {
    expect((await unlock(shortId, "nope")).status).toBe(401)
    const ok = await unlock(shortId, "hunter2")
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get("set-cookie")?.split(";")[0] ?? ""
    expect(cookie).toContain(`dku_${shortId}`)
    // With the unlock cookie an anonymous visitor reads the artifact and its bytes.
    expect((await app.request(`/v1/artifacts/${shortId}`, { headers: { cookie } })).status).toBe(
      200,
    )
    expect(
      (await app.request(`/v1/artifacts/${shortId}/content`, { headers: { cookie } })).status,
    ).toBe(200)
  })

  it("ignores a forged unlock cookie", async () => {
    const forged = { cookie: `dku_${shortId}=deadbeef` }
    expect((await app.request(`/v1/artifacts/${shortId}`, { headers: forged })).status).toBe(401)
  })
})

// Changing access after publish, from the Share dialog (PATCH /access). The lock
// is a gate on the world link — it only takes while link_role != none.
describe("permissions: locking the world link via PATCH /access", () => {
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "s3cret",
  })
  const owner = { authorization: "Bearer s3cret" }
  const patch = (id: string, body: object) =>
    app.request(`/v1/artifacts/${id}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify(body),
    })
  let shortId = ""

  it("locks a world-linked artifact (a password is required)", async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>x</h1>")]), "x.html")
    form.append("link_role", "viewer")
    shortId = (
      await (
        await app.request("/v1/artifacts", { method: "POST", body: form, headers: owner })
      ).json()
    ).short_id
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(200) // world link: anon reads
    // The legacy vocabulary still refuses to lock without a password…
    expect((await patch(shortId, { visibility: "password" })).status).toBe(400)
    // …and locking is a password on the live link.
    expect((await patch(shortId, { password: "sesame" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(401) // now locked
  })

  it("re-patching without a password keeps the lock; an empty password clears it", async () => {
    // Changing the link role (a bare PATCH) must not silently drop the lock.
    expect((await patch(shortId, { linkRole: "commenter" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(401) // still locked
    // Clearing is explicit: an empty password removes the lock.
    expect((await patch(shortId, { password: "" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(200)
  })

  it("dropping the link clears the lock — it cannot resurrect when a link returns", async () => {
    expect((await patch(shortId, { password: "sesame" })).status).toBe(200)
    expect((await patch(shortId, { linkRole: "none" })).status).toBe(200)
    expect((await patch(shortId, { linkRole: "viewer" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(200) // unlocked
  })
})
