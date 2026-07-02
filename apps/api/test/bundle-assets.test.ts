import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BundleManifest, publish } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { unzipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { manifestOf, mergeBundleZip, zipBundleFiles } from "../src/lib/bundle"

// MCP `publish` builds its bundle zip from a {path: content} map. Pages are text,
// but a real site also has images, fonts, etc. — binary that UTF-8 encoding would
// corrupt. zipBundleFiles carries base64 data: URI values as raw bytes so the whole
// site (pages + assets) rides one `files` map over MCP, and the core publish path
// stores + serves each asset with the right content-type. This is the fix for
// "Derive's MCP publish can't carry screenshots."

const dir = mkdtempSync(join(tmpdir(), "derive-bundle-assets-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A real 1x1 transparent PNG (starts with the 8-byte PNG signature).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"))
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe("zipBundleFiles carries binary assets, not just text", () => {
  it("decodes a base64 data: URI to raw bytes and keeps text pages as UTF-8", async () => {
    const files = {
      "index.html": "<h1>Réport</h1><img src=shot.png>", // non-ASCII to prove UTF-8 text
      "shot.png": `data:image/png;base64,${PNG_B64}`,
    }
    const unzipped = unzipSync(await zipBundleFiles(files))

    // The image is intact binary — the actual PNG, not the UTF-8 bytes of the data
    // URI string (which is what the old text-only packer produced).
    const shot = unzipped["shot.png"] as Uint8Array
    expect(Array.from(shot.slice(0, 8))).toEqual(PNG_SIGNATURE)
    expect(shot).toEqual(PNG_BYTES)

    // Text page survives as UTF-8 (multi-byte é round-trips).
    expect(new TextDecoder().decode(unzipped["index.html"])).toBe(files["index.html"])
  })

  it("throws an actionable error on a malformed base64 data: URI", async () => {
    await expect(
      zipBundleFiles({ "x.png": "data:image/png;base64,@@not base64@@" }),
    ).rejects.toThrow(/invalid base64 data URI for "x\.png"/)
  })
})

describe("an asset: reference resolves a pre-uploaded blob (images without base64)", () => {
  it("pulls the stored bytes for asset:<hash>, keeping text pages as text", async () => {
    const blobs = new FsBlobStore(join(dir, "ref-blobs"))
    // Simulate POST /v1/assets having stored the screenshot already.
    const key = await blobs.put(PNG_BYTES)
    const files = {
      "index.html": "<img src=shot.png>",
      "shot.png": `asset:${key}`,
    }
    const unzipped = unzipSync(await zipBundleFiles(files, blobs))
    expect(Array.from((unzipped["shot.png"] as Uint8Array).slice(0, 8))).toEqual(PNG_SIGNATURE)
    expect(unzipped["shot.png"]).toEqual(PNG_BYTES)
    expect(new TextDecoder().decode(unzipped["index.html"])).toBe("<img src=shot.png>")
  })

  it("rejects an unknown asset handle with an actionable 400", async () => {
    const blobs = new FsBlobStore(join(dir, "ref-blobs2"))
    await expect(zipBundleFiles({ "x.png": `asset:${"0".repeat(64)}` }, blobs)).rejects.toThrow(
      /unknown asset for "x\.png"/,
    )
  })

  it("rejects an asset reference when no blob store is available", async () => {
    await expect(zipBundleFiles({ "x.png": `asset:${"a".repeat(64)}` })).rejects.toThrow(
      /asset references are not supported/,
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
      bytes: await zipBundleFiles(files),
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

describe("incremental merge grows a bundle without re-sending it", () => {
  it("keeps existing files, adds new ones, overwrites same-path, bumps the version", async () => {
    const meta = new SqliteMetaStore(join(dir, "merge.db"))
    const blobs = new FsBlobStore(join(dir, "merge-blobs"))

    // First publish: an index page + one screenshot.
    const first = await publish(meta, blobs, {
      bytes: await zipBundleFiles({
        "index.html": "<img src=a.png>",
        "a.png": `data:image/png;base64,${PNG_B64}`,
      }),
      filename: "site.zip",
      isBundle: true,
      title: "Site",
      author: "t",
    })
    const m1 = (await manifestOf(blobs, first.version)) as BundleManifest
    expect(Object.keys(m1.files).sort()).toEqual(["/a.png", "/index.html"])

    // The incremental call carries ONLY the delta — a new b.png plus an updated
    // index.html. a.png is never re-sent; mergeBundleZip reads it back from its blob.
    const unionZip = await mergeBundleZip(blobs, m1, {
      "index.html": "<img src=a.png><img src=b.png>",
      "b.png": `data:image/png;base64,${PNG_B64}`,
    })
    const second = await publish(
      meta,
      blobs,
      { bytes: unionZip, filename: "site.zip", isBundle: true, author: "t" },
      first.artifact.short_id,
    )
    const m2 = (await manifestOf(blobs, second.version)) as BundleManifest

    // Existing asset preserved, new asset added, page overwritten — one new version.
    expect(Object.keys(m2.files).sort()).toEqual(["/a.png", "/b.png", "/index.html"])
    expect(m2.files["/b.png"]?.type).toBe("image/png")
    expect(second.version.n).toBe(2)

    // a.png bytes are intact (came back from its blob, never re-sent over the wire).
    const aBytes = (await blobs.get(m2.files["/a.png"]?.key as string)) as Uint8Array
    expect(new Uint8Array(aBytes)).toEqual(PNG_BYTES)
    // index.html reflects the overwrite.
    const html = new TextDecoder().decode(
      (await blobs.get(m2.files["/index.html"]?.key as string)) as Uint8Array,
    )
    expect(html).toContain("b.png")
  })
})
