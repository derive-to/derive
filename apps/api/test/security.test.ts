import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { beforeAll, describe, expect, it } from "vitest"
import { createApp, isPublicHttpUrl } from "../src/app"
import {
  app,
  as,
  dir,
  jsonAs,
  makeAuthedApp,
  meta,
  ownerApp,
  publishAs,
  type TestUser,
  upload,
} from "./helpers"

describe("security: sandbox serving origin (A4)", () => {
  const app = ownerApp({
    meta: new SqliteMetaStore(join(dir, "sandbox.db")),
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://app.test",
    sandboxOrigin: "http://sandbox.test",
  })
  let shortId: string

  it("serves artifact bytes only from the sandbox host; the app host redirects there", async () => {
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode("<h1>user html</h1>")]), "x.html")
    shortId = (
      await (await app.request("http://app.test/v1/artifacts", { method: "POST", body: fd })).json()
    ).short_id

    // App (cookie) origin must never render user HTML — it 302s to the sandbox.
    // The SPA's artifact iframe uses `${API_BASE}/raw/...` on the app origin; this
    // redirect is what lands it on the sandbox origin, so untrusted HTML never
    // touches the app's cookies. The isolation lives in this route, not in any
    // server-rendered shell (the viewer is the SPA, client-rendered).
    const onApp = await app.request(`http://app.test/raw/${shortId}/v/1/index.html`)
    expect(onApp.status).toBe(302)
    expect(onApp.headers.get("location")).toBe(`http://sandbox.test/raw/${shortId}/v/1/index.html`)

    // The sandbox origin serves the bytes.
    const onSandbox = await app.request(`http://sandbox.test/raw/${shortId}/v/1/index.html`)
    expect(onSandbox.status).toBe(200)
    expect(await onSandbox.text()).toContain("<h1>user html</h1>")
  })

  it("the sandbox host exposes ONLY raw bytes — never the API, auth, or the app", async () => {
    expect((await app.request("http://sandbox.test/v1/artifacts")).status).toBe(404)
    expect((await app.request("http://sandbox.test/api/auth/get-session")).status).toBe(404)
    expect((await app.request(`http://sandbox.test/artifacts/${shortId}`)).status).toBe(404)
    // Health stays reachable on the sandbox host (for its own monitoring).
    expect((await app.request("http://sandbox.test/healthz")).status).toBe(200)
  })

  it("without a sandbox origin, raw is served in place (single-origin self-host)", async () => {
    const solo = ownerApp({
      meta: new SqliteMetaStore(join(dir, "solo.db")),
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: "http://app.test",
    })
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode("<h1>solo</h1>")]), "s.html")
    const sid = (await (await solo.request("/v1/artifacts", { method: "POST", body: fd })).json())
      .short_id
    const raw = await solo.request(`/raw/${sid}/v/1/index.html`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain("<h1>solo</h1>")
  })
})

describe("security: webhook SSRF guard", () => {
  const owner: TestUser = { id: "u_wh", email: "wh@derive.test", name: "Wh" }
  const { app } = makeAuthedApp("ssrf", [owner])
  const create = (url: string) =>
    app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ url }),
    })

  it("rejects private, loopback, and metadata targets", async () => {
    const blocked = [
      "http://127.0.0.1/x",
      "http://localhost/x",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/hook",
      "http://192.168.1.10/hook",
      "http://[::1]/x",
      "ftp://example.com/x",
    ]
    for (const url of blocked) {
      const r = await create(url)
      expect(r.status, `should block ${url}`).toBe(400)
    }
  })

  it("accepts a public https url", async () => {
    expect((await create("https://hooks.example.com/abc")).status).toBe(201)
  })
})

describe("security: rate limiting", () => {
  const limited = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    rateLimit: true,
  })

  it("429s once the auth window cap is exceeded", async () => {
    let status = 0
    for (let i = 0; i < 22; i++) {
      status = (
        await limited.request("/api/auth/get-session", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        })
      ).status
    }
    expect(status).toBe(429)
  })
})

describe("SSRF guard: integer/hex/octal IP encodings can't bypass the private-range check", () => {
  it("blocks loopback / metadata / private in every encoding", () => {
    for (const u of [
      "http://127.0.0.1/", // dotted
      "http://2130706433/", // decimal int = 127.0.0.1
      "http://0x7f000001/", // hex = 127.0.0.1
      "http://0177.0.0.1/", // octal octet = 127.0.0.1
      "http://127.1/", // short form = 127.0.0.1
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 loopback
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://localhost/", // name
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/", // IPv6 loopback
      "ftp://example.com/", // wrong scheme
    ]) {
      expect(isPublicHttpUrl(u)).toBe(false)
    }
  })

  it("allows genuinely public hosts", () => {
    for (const u of [
      "https://hooks.example.com/abc",
      "http://8.8.8.8/",
      "http://1.1.1.1/",
      "https://203.0.113.10/webhook",
    ]) {
      expect(isPublicHttpUrl(u)).toBe(true)
    }
  })
})

describe("security: raw token caching", () => {
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
    expect(
      Date.parse(rec.raw_token_expires_at),
      "the record should say when its cached raw capability expires",
    ).toBeGreaterThan(Date.now())
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
  })

  describe("raw token bucketing", () => {
    it("mints a byte-identical token across a window, so the viewer URL is cacheable", async () => {
      const { app } = makeAuthedApp("rawcache-bucket", [owner])
      const h = as(owner.email)
      const pub = await (await publishAs(app, "<h1>b</h1>", { title: "Bucket" }, h)).json()
      const tokenNow = async () =>
        (await (await app.request(`/v1/artifacts/${pub.short_id}`, { headers: h })).json())
          .raw_token

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
})

// Authorship must key on the stable actor id, never the mutable display name:
// renaming your profile to a victim's name must not grant edit/delete/withdraw.
describe("authorship is keyed on id, not display name", () => {
  const owner: TestUser = { id: "u_own", email: "own@derive.test", name: "Owner" }
  const sam1: TestUser = { id: "u_sam1", email: "sam1@derive.test", name: "Sam" }
  // Same display name as sam1, different id — the impersonation attempt.
  const sam2: TestUser = { id: "u_sam2", email: "sam2@derive.test", name: "Sam" }
  const { app: authed } = makeAuthedApp("id-authz", [owner, sam1, sam2], "editor")
  let shortId: string
  let commentId: string

  // Seed an artifact + a comment authored by sam1.
  beforeAll(async () => {
    shortId = (
      await (await publishAs(authed, "<h1>doc</h1>", { visibility: "org" }, as(sam1.email))).json()
    ).short_id
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
