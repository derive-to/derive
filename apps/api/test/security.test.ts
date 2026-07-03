import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp, isPublicHttpUrl } from "../src/app"
import { as, dir, makeAuthedApp, meta, ownerApp, type TestUser } from "./helpers"

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
