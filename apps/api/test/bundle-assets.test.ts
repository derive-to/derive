import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publish } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { unzipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { manifestOf, zipBundleFiles } from "../src/lib/bundle"

// MCP `publish` builds its bundle zip from a {path: content} map. Pages are text,
// but a real site also has images, fonts, etc. — binary that UTF-8 encoding would
// corrupt. zipBundleFiles carries base64 data: URI values as raw bytes so the whole
// site (pages + assets) rides one `files` map over MCP, and the core publish path
// stores + serves each asset with the right content-type. This is the fix for
// "Dock's MCP publish can't carry screenshots."

const dir = mkdtempSync(join(tmpdir(), "dock-bundle-assets-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A real 1x1 transparent PNG (starts with the 8-byte PNG signature).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"))
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe("zipBundleFiles carries binary assets, not just text", () => {
  it("decodes a base64 data: URI to raw bytes and keeps text pages as UTF-8", () => {
    const files = {
      "index.html": "<h1>Réport</h1><img src=shot.png>", // non-ASCII to prove UTF-8 text
      "shot.png": `data:image/png;base64,${PNG_B64}`,
    }
    const unzipped = unzipSync(zipBundleFiles(files))

    // The image is intact binary — the actual PNG, not the UTF-8 bytes of the data
    // URI string (which is what the old text-only packer produced).
    const shot = unzipped["shot.png"] as Uint8Array
    expect(Array.from(shot.slice(0, 8))).toEqual(PNG_SIGNATURE)
    expect(shot).toEqual(PNG_BYTES)

    // Text page survives as UTF-8 (multi-byte é round-trips).
    expect(new TextDecoder().decode(unzipped["index.html"])).toBe(files["index.html"])
  })

  it("throws an actionable error on a malformed base64 data: URI", () => {
    expect(() => zipBundleFiles({ "x.png": "data:image/png;base64,@@not base64@@" })).toThrow(
      /invalid base64 data URI for "x\.png"/,
    )
  })
})

describe("a binary bundle publishes and serves the asset with the right type", () => {
  it("stores the PNG as image/png and preserves its bytes end to end", async () => {
    const meta = new SqliteMetaStore(join(dir, "site.db"))
    const blobs = new FsBlobStore(join(dir, "blobs"))
    const files = {
      "index.html": "<!doctype html><img src=shot.png>",
      "shot.png": `data:image/png;base64,${PNG_B64}`,
    }

    const { version } = await publish(meta, blobs, {
      bytes: zipBundleFiles(files),
      filename: "site.zip",
      isBundle: true,
      title: "Site",
      author: "Tester",
    })

    const manifest = await manifestOf(blobs, version)
    expect(manifest, "published as a bundle").not.toBeNull()
    const png = manifest?.files["/shot.png"]
    // content-type is inferred from the .png extension by the core publish path.
    expect(png?.type).toBe("image/png")

    const stored = await blobs.get(png?.key as string)
    expect(stored, "blob is present").toBeTruthy()
    expect(new Uint8Array(stored as Uint8Array)).toEqual(PNG_BYTES)

    // The html entry page is intact too.
    const entry = manifest?.files[manifest.entry]
    expect(manifest?.entry).toBe("/index.html")
    const html = new TextDecoder().decode((await blobs.get(entry?.key as string)) as Uint8Array)
    expect(html).toContain("<img src=shot.png>")
  })
})
