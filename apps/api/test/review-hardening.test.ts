import { describe, expect, it } from "vitest"
import {
  app,
  as,
  jsonAs,
  makeAuthedApp,
  proposeAs,
  publishAs,
  type TestUser,
  upload,
} from "./helpers"

// Authorship must key on the stable actor id, never the mutable display name:
// renaming your profile to a victim's name must not grant edit/delete/withdraw.
describe("authorship is keyed on id, not display name", () => {
  const owner: TestUser = { id: "u_own", email: "own@dock.test", name: "Owner" }
  const sam1: TestUser = { id: "u_sam1", email: "sam1@dock.test", name: "Sam" }
  // Same display name as sam1, different id — the impersonation attempt.
  const sam2: TestUser = { id: "u_sam2", email: "sam2@dock.test", name: "Sam" }
  const { app: authed } = makeAuthedApp("id-authz", [owner, sam1, sam2], "editor")
  let shortId: string
  let commentId: string

  it("seeds an artifact + a comment authored by sam1", async () => {
    shortId = (await (await publishAs(authed, "<h1>doc</h1>", {}, as(sam1.email))).json()).short_id
    const res = await authed.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(sam1.email), { body_md: "sam1's note" }),
    )
    expect(res.status).toBe(201)
    commentId = (await res.json()).id
  })

  it("refuses edit + delete from a different user who shares the display name", async () => {
    const edit = await authed.request(`/v1/artifacts/${shortId}/comments/${commentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(sam2.email) },
      body: JSON.stringify({ body_md: "hijacked" }),
    })
    expect(edit.status).toBe(403)
    const del = await authed.request(`/v1/artifacts/${shortId}/comments/${commentId}`, {
      method: "DELETE",
      headers: as(sam2.email),
    })
    expect(del.status).toBe(403)
  })

  it("allows the real author (matched by id) to edit", async () => {
    const edit = await authed.request(`/v1/artifacts/${shortId}/comments/${commentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(sam1.email) },
      body: JSON.stringify({ body_md: "sam1 edited" }),
    })
    expect(edit.status).toBe(200)
    expect((await edit.json()).body_md).toBe("sam1 edited")
  })

  it("refuses proposal withdraw from a same-named non-author, allows the author", async () => {
    const p = await (await proposeAs(authed, shortId, "<h1>v2</h1>", as(sam1.email))).json()
    const bad = await authed.request(`/v1/artifacts/${shortId}/proposals/${p.id}/withdraw`, {
      method: "POST",
      headers: as(sam2.email),
    })
    expect(bad.status).toBe(403)
    const ok = await authed.request(`/v1/artifacts/${shortId}/proposals/${p.id}/withdraw`, {
      method: "POST",
      headers: as(sam1.email),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).state).toBe("withdrawn")
  })
})

// Clickjacking + transport hardening on the app (cookie) origin, without touching
// the artifact sandbox or the embed surface.
describe("app-origin security headers", () => {
  it("locks framing + sets nosniff on app/API responses", async () => {
    const res = await app.request("/healthz")
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("sets HSTS only over https", async () => {
    expect((await app.request("/healthz")).headers.get("strict-transport-security")).toBeNull()
    const https = await app.request("/healthz", { headers: { "x-forwarded-proto": "https" } })
    expect(https.headers.get("strict-transport-security")).toContain("max-age=63072000")
  })

  it("never frame-locks artifact bytes — they keep the sandbox CSP", async () => {
    const sid = (
      await (await upload("h.html", "<h1>hi</h1>", { title: "H", visibility: "public" })).json()
    ).short_id
    const raw = await app.request(`/raw/${sid}/v/1/index.html`)
    expect(raw.headers.get("content-security-policy")).toContain("sandbox")
    expect(raw.headers.get("x-frame-options")).toBeNull()
  })
})

// A shared/CDN cache must never hold a gated artifact's bytes and replay them to
// a viewer who never passed the gate: only fully-public content is immutable.
describe("visibility-aware raw caching", () => {
  it("serves public bytes immutable, gated bytes no-store", async () => {
    const pub = (
      await (await upload("p.html", "<h1>p</h1>", { title: "P", visibility: "public" })).json()
    ).short_id
    expect(
      (await app.request(`/raw/${pub}/v/1/index.html`)).headers.get("cache-control"),
    ).toContain("immutable")

    // Default visibility is `link` (gated by URL possession, not fully public).
    const gated = (await (await upload("q.html", "<h1>q</h1>", { title: "Q" })).json()).short_id
    expect((await app.request(`/raw/${gated}/v/1/index.html`)).headers.get("cache-control")).toBe(
      "private, no-store",
    )
  })
})
