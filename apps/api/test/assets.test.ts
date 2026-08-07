import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { signUploadToken } from "../src/lib/upload-token"
import { PNG_BYTES } from "./fixtures"
import { anonApp, app, dir, ownerApp } from "./helpers"

// POST /v1/assets is the "images without base64" path: an agent streams the raw bytes
// of a screenshot up as binary (no transcription), gets back a content-addressed
// `asset:<hash>` handle, and references that handle in a `publish` files map — where
// decodeBundleFiles resolves it back to these exact bytes (see bundle-assets.test.ts).

const postAsset = (body: BodyInit, contentType?: string) =>
  app.request("/v1/assets", {
    method: "POST",
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
    body,
  })

describe("POST /v1/assets", () => {
  it("stores raw-binary image bytes and returns a content-addressed asset handle + public url", async () => {
    const res = await postAsset(PNG_BYTES, "image/png")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe("image/png")
    expect(body.size).toBe(PNG_BYTES.byteLength)
    expect(body.original_size).toBe(PNG_BYTES.byteLength)
    expect(body.optimization_available).toBe(false)
    expect(body.mode).toBe("full_size")
    expect(body.optimized).toBe(false)
    expect(body.cost).toContain("full size")
    expect(body.key).toMatch(/^[0-9a-f]{64}$/)
    expect(body.ref).toBe(`asset:${body.key}`)
    expect(body.url).toBe(`http://derive.test/blob/${body.key}.png`)

    // The exact bytes are stored at that key, ready for a publish to reference.
    const blobs = new FsBlobStore(join(dir, "blobs"))
    const stored = await blobs.get(body.key)
    expect(stored).toBeTruthy()
    expect(new Uint8Array(stored as Uint8Array)).toEqual(PNG_BYTES)

    // And the returned `url` actually serves those bytes back.
    const served = await app.request(new URL(body.url).pathname)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it("accepts a multipart file field and dedups identical bytes to the same key", async () => {
    const raw = await (await postAsset(PNG_BYTES, "image/png")).json()
    const fd = new FormData()
    fd.append("file", new Blob([PNG_BYTES as BlobPart], { type: "image/png" }), "shot.png")
    const res = await postAsset(fd)
    expect(res.status).toBe(200)
    // Content-addressed: the same bytes hash to the same key regardless of transport.
    const body = await res.json()
    expect(body.key).toBe(raw.key)
    expect(body.url).toBe(raw.url)
  })

  it("trusts the bytes, not the type — rejects a non-image with a 400", async () => {
    const res = await postAsset(new TextEncoder().encode("<svg>not raster</svg>"), "image/png")
    expect(res.status).toBe(400)
  })

  it("stores a woff2 font and serves it back with the font content-type", async () => {
    // Magic bytes 'wOF2'; the route only sniffs the header, so a stub body suffices.
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 4, 5])
    const res = await postAsset(woff2, "font/woff2")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe("font/woff2")
    expect(body.url).toMatch(/\.woff2$/)

    const served = await app.request(new URL(body.url).pathname)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("font/woff2")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(woff2)
  })

  it("rejects an empty body", async () => {
    const res = await postAsset(new Uint8Array(), "image/png")
    expect(res.status).toBe(400)
  })

  it("is closed to anonymous callers (the write-lockdown)", async () => {
    const res = await anonApp.request("/v1/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    })
    expect(res.status).toBe(403)
  })
})

describe("asset optimization", () => {
  const optimizeMeta = new SqliteMetaStore(join(dir, "asset-optimize.db"))
  let calls = 0
  const optimizeApp = ownerApp({
    meta: optimizeMeta,
    blobs: new FsBlobStore(join(dir, "asset-optimize-blobs")),
    baseUrl: "http://derive.test",
    optimizeImage: async () => {
      calls++
      return PNG_BYTES
    },
  })
  afterAll(() => optimizeMeta.close())

  // Header-valid enough for the route's byte sniff + dimension reader, deliberately
  // padded so the fake optimizer has a smaller same-format candidate to select.
  const largePng = new Uint8Array(PNG_BYTES.byteLength + 1024)
  largePng.set(PNG_BYTES)
  new DataView(largePng.buffer).setUint32(16, 2400)
  new DataView(largePng.buffer).setUint32(20, 1200)

  it("stores the smaller optimized image by default and reports the savings", async () => {
    const res = await optimizeApp.request("/v1/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: largePng,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      type: "image/png",
      optimization_available: true,
      mode: "optimized",
      optimized: true,
      size: PNG_BYTES.byteLength,
      original_size: largePng.byteLength,
      width: 1,
      height: 1,
      original_width: 2400,
      original_height: 1200,
    })
    expect(body.cost).toContain("smaller")

    const served = await optimizeApp.request(new URL(body.url).pathname)
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it("full_size=true bypasses optimization and preserves the exact upload", async () => {
    const before = calls
    const res = await optimizeApp.request("/v1/assets?full_size=true", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: largePng,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      optimization_available: true,
      mode: "full_size",
      optimized: false,
      size: largePng.byteLength,
      original_size: largePng.byteLength,
      width: 2400,
      height: 1200,
    })
    expect(body.cost).toContain("full size")
    expect(calls).toBe(before)

    const served = await optimizeApp.request(new URL(body.url).pathname)
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(largePng)
  })
})

// The tokened entry point: a short-lived signed capability (minted by the MCP
// stage_asset tool) takes the place of the session/bearer, so an agent whose only
// credential lives inside the MCP transport can still stream raw bytes from its
// shell. Requests here are deliberately UNAUTHENTICATED — the token is the proof.
describe("POST /v1/assets/t/:token (MCP-minted upload URL)", () => {
  const UPLOAD_SECRET = "test-upload-secret-long-enough"
  const tokMeta = new SqliteMetaStore(join(dir, "upload-token.db"))
  const tokApp = createApp({
    meta: tokMeta,
    blobs: new FsBlobStore(join(dir, "upload-token-blobs")),
    baseUrl: "http://derive.test",
    token: "tok",
    encryptionKey: UPLOAD_SECRET,
  })
  afterAll(() => tokMeta.close())

  const postTokened = (token: string, body: BodyInit) =>
    tokApp.request(`/v1/assets/t/${token}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body,
    })

  // An unbound token (empty principal — what an ownerless legacy agent mints):
  // no membership re-check, the mint-time role check was all there is.
  const unbound = (exp: number) => signUploadToken(UPLOAD_SECRET, "default", "", exp)

  it("a valid token stages bytes with no auth header and returns the same handle shape", async () => {
    const tok = await unbound(Date.now() + 60_000)
    const res = await postTokened(tok, PNG_BYTES)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe("image/png")
    expect(body.ref).toBe(`asset:${body.key}`)
    expect(body.url).toBe(`http://derive.test/blob/${body.key}.png`)

    // The permanent URL serves the exact bytes back — same as the authed route.
    const served = await tokApp.request(new URL(body.url).pathname)
    expect(served.status).toBe(200)
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it("the token is reusable until expiry (one mint stages a batch)", async () => {
    const tok = await unbound(Date.now() + 60_000)
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 4, 5])
    expect((await postTokened(tok, PNG_BYTES)).status).toBe(200)
    expect((await postTokened(tok, woff2)).status).toBe(200)
  })

  it("an expired token → 403", async () => {
    const tok = await unbound(Date.now() - 1_000)
    expect((await postTokened(tok, PNG_BYTES)).status).toBe(403)
  })

  it("a garbage token → 403", async () => {
    expect((await postTokened("garbage", PNG_BYTES)).status).toBe(403)
  })

  it("a user-bound token dies with the user's publish rights (revocation mid-TTL)", async () => {
    // Bind a token to a member who can publish; it works. Demote them to
    // commenter and the SAME still-unexpired token is refused on the next
    // request — capability URLs must not outlive the grant that minted them.
    const uid = "u_upload"
    await tokMeta.setMembership({
      id: randomUUID(),
      org_id: "default",
      user_id: uid,
      role: "editor",
    })
    const tok = await signUploadToken(UPLOAD_SECRET, "default", uid, Date.now() + 60_000)
    expect((await postTokened(tok, PNG_BYTES)).status).toBe(200)

    await tokMeta.setMembership({
      id: randomUUID(),
      org_id: "default",
      user_id: uid,
      role: "commenter",
    })
    expect((await postTokened(tok, PNG_BYTES)).status).toBe(403)
  })

  it("a token bound to a non-member → 403", async () => {
    const tok = await signUploadToken(UPLOAD_SECRET, "default", "u_ghost", Date.now() + 60_000)
    expect((await postTokened(tok, PNG_BYTES)).status).toBe(403)
  })

  it("still sniffs the bytes — a valid token can't stage a non-asset format", async () => {
    const tok = await unbound(Date.now() + 60_000)
    const res = await postTokened(tok, new TextEncoder().encode("<svg>not raster</svg>"))
    expect(res.status).toBe(400)
  })

  it("fails closed on a server with no signing secret", async () => {
    // The shared helper app has no encryptionKey; even a well-formed token is 403.
    const tok = await unbound(Date.now() + 60_000)
    const res = await anonApp.request(`/v1/assets/t/${tok}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    })
    expect(res.status).toBe(403)
  })
})
