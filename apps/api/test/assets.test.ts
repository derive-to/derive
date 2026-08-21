import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { signUploadToken } from "../src/lib/upload-token"
import { PNG_BYTES } from "./fixtures"
import { anonApp, app, dir } from "./helpers"

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

  it("is closed to anonymous callers (the write-lockdown)", async () => {
    const res = await anonApp.request("/v1/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    })
    expect(res.status).toBe(403)
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

describe("blob", () => {
  // GET /blob/:hash is the public capability URL side of POST /v1/assets (above): a
  // permanent, unauthenticated link to a staged image's bytes.
  // The one thing this route must never do is serve a hash it only knows about
  // because SOME OTHER blob (a bundle manifest, an HTML page) happens to live at
  // that key in the shared content-addressed store — only a hash with its own
  // `asset` row (written at upload) is fair game. That's the security boundary
  // under test here, not just the happy path.

  const postPng = async () => {
    const res = await app.request("/v1/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    })
    return res.json()
  }

  describe("GET /blob/:file", () => {
    it("serves a staged asset's bytes, unauthenticated, with an immutable cache header", async () => {
      const { key } = await postPng()
      const res = await app.request(`/blob/${key}.png`, { headers: {} }) // no auth header at all
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/png")
      expect(res.headers.get("cache-control")).toContain("immutable")
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES)
    })

    it("404s a well-formed hash that was never uploaded", async () => {
      const res = await app.request(`/blob/${"0".repeat(64)}.png`)
      expect(res.status).toBe(404)
    })

    it("SECURITY: never serves a blob-store hash that has no asset row (a bundle manifest, an HTML page)", async () => {
      // Simulate a real bytes-in-the-store-but-not-a-staged-asset case: a private
      // bundle's manifest JSON or an HTML page blob, which lives in the exact same
      // content-addressed store /blob reads from. Without the asset-row gate this
      // would leak arbitrary artifact content by hash, unauthenticated.
      const blobs = new FsBlobStore(join(dir, "blobs"))
      const hash = await blobs.put(new TextEncoder().encode('{"entry":"/index.html","files":{}}'))
      const res = await app.request(`/blob/${hash}`)
      expect(res.status).toBe(404)
    })
  })
})
