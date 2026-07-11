import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { app, dir } from "./helpers"

// GET /blob/:hash is the public capability URL side of POST /v1/assets (see
// assets.test.ts): a permanent, unauthenticated link to a staged image's bytes.
// The one thing this route must never do is serve a hash it only knows about
// because SOME OTHER blob (a bundle manifest, an HTML page) happens to live at
// that key in the shared content-addressed store — only a hash with its own
// `asset` row (written at upload) is fair game. That's the security boundary
// under test here, not just the happy path.

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"))

const postAsset = async () => {
  const res = await app.request("/v1/assets", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG_BYTES,
  })
  return res.json()
}

describe("GET /blob/:file", () => {
  it("serves a staged asset's bytes, unauthenticated, with an immutable cache header", async () => {
    const { key } = await postAsset()
    const res = await app.request(`/blob/${key}.png`, { headers: {} }) // no auth header at all
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it("ignores the file extension — serves the persisted content-type regardless", async () => {
    const { key } = await postAsset()
    for (const suffix of ["", ".png", ".jpg", ".anything"]) {
      const res = await app.request(`/blob/${key}${suffix}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/png")
    }
  })

  it("404s a well-formed hash that was never uploaded", async () => {
    const res = await app.request(`/blob/${"0".repeat(64)}.png`)
    expect(res.status).toBe(404)
  })

  it("404s malformed file params (not a 64-hex hash)", async () => {
    for (const bad of ["not-a-hash", "abc.png", `${"g".repeat(64)}.png`, `${"a".repeat(63)}.png`]) {
      expect((await app.request(`/blob/${bad}`)).status).toBe(404)
    }
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
