import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { anonApp, app, dir } from "./helpers"

// POST /v1/assets is the "images without base64" path: an agent streams the raw bytes
// of a screenshot up as binary (no transcription), gets back a content-addressed
// `asset:<hash>` handle, and references that handle in a `publish` files map — where
// decodeBundleFiles resolves it back to these exact bytes (see bundle-assets.test.ts).

// A real 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"))

const postAsset = (body: BodyInit, contentType?: string) =>
  app.request("/v1/assets", {
    method: "POST",
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
    body,
  })

describe("POST /v1/assets", () => {
  it("stores raw-binary image bytes and returns a content-addressed asset handle", async () => {
    const res = await postAsset(PNG_BYTES, "image/png")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe("image/png")
    expect(body.size).toBe(PNG_BYTES.byteLength)
    expect(body.key).toMatch(/^[0-9a-f]{64}$/)
    expect(body.ref).toBe(`asset:${body.key}`)

    // The exact bytes are stored at that key, ready for a publish to reference.
    const blobs = new FsBlobStore(join(dir, "blobs"))
    const stored = await blobs.get(body.key)
    expect(stored).toBeTruthy()
    expect(new Uint8Array(stored as Uint8Array)).toEqual(PNG_BYTES)
  })

  it("accepts a multipart file field and dedups identical bytes to the same key", async () => {
    const raw = await (await postAsset(PNG_BYTES, "image/png")).json()
    const fd = new FormData()
    fd.append("file", new Blob([PNG_BYTES as BlobPart], { type: "image/png" }), "shot.png")
    const res = await postAsset(fd)
    expect(res.status).toBe(200)
    // Content-addressed: the same bytes hash to the same key regardless of transport.
    expect((await res.json()).key).toBe(raw.key)
  })

  it("trusts the bytes, not the type — rejects a non-image with a 400", async () => {
    const res = await postAsset(new TextEncoder().encode("<svg>not raster</svg>"), "image/png")
    expect(res.status).toBe(400)
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
