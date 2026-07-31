import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// A gated artifact's bytes are private, no-store on the cookie route — correct, and the
// reason the viewer re-downloads them on every open. On the TOKEN route that can be
// bounded rather than forbidden: the URL carries a capability that expires, so a private
// cache entry keyed on it cannot outlive the access it was granted under. These pin that
// distinction, because getting it wrong is a disclosure bug, not a slow page.
const owner: TestUser = { id: "u_rawcache", email: "rawcache@derive.test", name: "Raw Cache" }

const tokenUrlFor = async (
  app: ReturnType<typeof makeAuthedApp>["app"],
  shortId: string,
  headers: Record<string, string>,
) => {
  const rec = await (await app.request(`/v1/artifacts/${shortId}`, { headers })).json()
  expect(rec.raw_token, "the record should carry a raw token for the viewer").toBeTruthy()
  return `/raw/${shortId}/v/${rec.current_version}/t/${rec.raw_token}/index.html`
}

describe("raw content cache-control", () => {
  it("a PRIVATE artifact is cacheable only privately, and only for the token's lifetime", async () => {
    const { app } = makeAuthedApp("rawcache-private", [owner])
    const h = as(owner.email)
    const pub = await (await publishAs(app, "<h1>private</h1>", { title: "Private" }, h)).json()

    const res = await app.request(await tokenUrlFor(app, pub.short_id, h), { headers: h })
    expect(res.status).toBe(200)
    const cc = res.headers.get("Cache-Control") ?? ""
    // Private, so no shared cache may ever hold a gated artifact's bytes...
    expect(cc).toContain("private")
    // ...but the browser may, bounded by the same 5 minutes the token itself lasts.
    expect(cc).toContain("max-age=300")
    expect(cc).not.toContain("no-store")
  })

  it("the COOKIE route keeps no-store for the same artifact — no capability bound there", async () => {
    const { app } = makeAuthedApp("rawcache-cookie", [owner])
    const h = as(owner.email)
    const pub = await (await publishAs(app, "<h1>private</h1>", { title: "Private" }, h)).json()

    const res = await app.request(`/raw/${pub.short_id}/v/1/index.html`, { headers: h })
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("no-store")
  })

  it("a PUBLIC artifact stays immutable on the token route", async () => {
    const { app } = makeAuthedApp("rawcache-public", [owner])
    const h = as(owner.email)
    const pub = await (
      await publishAs(app, "<h1>public</h1>", { title: "Public", link_role: "viewer" }, h)
    ).json()

    const res = await app.request(await tokenUrlFor(app, pub.short_id, h), { headers: h })
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("immutable")
  })
})
