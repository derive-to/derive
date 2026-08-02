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
    // ...but the browser may, bounded by the token WINDOW (2 min), which is shorter than
    // the token's validity — so a cache entry can never outlive the URL that reaches it.
    expect(cc).toContain("max-age=120")
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

describe("raw token bucketing", () => {
  it("mints a byte-identical token across a window, so the viewer URL is cacheable", async () => {
    const { app } = makeAuthedApp("rawcache-bucket", [owner])
    const h = as(owner.email)
    const pub = await (await publishAs(app, "<h1>b</h1>", { title: "Bucket" }, h)).json()
    const tokenNow = async () =>
      (await (await app.request(`/v1/artifacts/${pub.short_id}`, { headers: h })).json()).raw_token

    // Two fetches moments apart used to produce two different tokens — and therefore two
    // different iframe URLs, which is how the cache entry became unreachable on re-open.
    expect(await tokenNow()).toBe(await tokenNow())
  })

  it("a bucketed token is still accepted, and still expires", async () => {
    const { bucketedNow, signState, verifyState } = await import("../src/lib/crypto")
    const { RAW_TOKEN_MAX_AGE_MS, RAW_TOKEN_WINDOW_MS } = await import("../src/lib/http")
    const secret = "test-secret"
    const now = 1_800_000_000_000

    const tok = signState({ rid: "a_1" }, secret, bucketedNow(RAW_TOKEN_WINDOW_MS, now))
    // Valid right away...
    expect(verifyState<{ rid: string }>(tok, secret, RAW_TOKEN_MAX_AGE_MS, now)?.rid).toBe("a_1")
    // ...and still valid at the worst case: minted at a bucket boundary, read a full
    // window later. This is the guarantee the window-shorter-than-validity gap buys.
    expect(
      verifyState<{ rid: string }>(tok, secret, RAW_TOKEN_MAX_AGE_MS, now + RAW_TOKEN_WINDOW_MS)
        ?.rid,
    ).toBe("a_1")
    // Bucketing must not extend the ceiling: past the max age it is dead as before.
    expect(
      verifyState(tok, secret, RAW_TOKEN_MAX_AGE_MS, now + RAW_TOKEN_MAX_AGE_MS + 1000),
    ).toBeNull()
  })
})
