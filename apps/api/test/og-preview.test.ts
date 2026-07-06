/**
 * Task 6: /v1/og/:ref serves the rendered PNG when preview_status === "ready",
 * falls back to the SVG card otherwise, and NEVER leaks the PNG for a private
 * artifact to an anonymous requester.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"

const dir = mkdtempSync(join(tmpdir(), "derive-og-preview-"))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TOKEN = "tok"
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** A minimal valid 1x1 PNG (67 bytes). */
const TINY_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk length + type
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // 1x1
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53, // 8-bit RGB, crc
  0xde,
  0x00,
  0x00,
  0x00,
  0x0c,
  0x49,
  0x44,
  0x41, // IDAT chunk
  0x54,
  0x08,
  0xd7,
  0x63,
  0xf8,
  0xcf,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x01,
  0xe2,
  0x21,
  0xbc,
  0x33,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e, // IEND chunk
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
])

const makeApp = (name: string) => {
  const dbPath = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(dbPath)
  const blobs = new FsBlobStore(join(dir, `blobs-${name}`))
  const app = createApp({
    meta,
    blobs,
    baseUrl: "http://derive.test",
    token: TOKEN,
  })
  return { app, meta, blobs }
}

/** Upload an artifact via the API and return its short_id + current_version. */
const publish = async (
  app: ReturnType<typeof createApp>,
  content: string,
  fields: Record<string, string> = {},
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await app.request("/v1/artifacts", { method: "POST", body: form, headers: AUTH })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { short_id: string; current_version: number }
  return body
}

describe("/v1/og/:ref — PNG preview serving", () => {
  it("returns SVG when there is no preview yet", async () => {
    const { app } = makeApp("og-no-preview")
    const { short_id } = await publish(app, "<h1>Hi</h1>", {
      visibility: "public",
      title: "No Preview",
    })

    const res = await app.request(`/v1/og/${short_id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const body = await res.text()
    expect(body).toContain("<svg")
  })

  it("returns PNG bytes when preview_status is ready", async () => {
    const { app, meta, blobs } = makeApp("og-with-preview")
    const { short_id, current_version } = await publish(app, "<h1>Ready</h1>", {
      visibility: "public",
      title: "Preview Ready",
    })

    // Resolve the internal artifact id (not returned by the publish API).
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")

    // Store a PNG in the blob store and mark the version preview as ready.
    const pngKey = await blobs.put(TINY_PNG)
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: pngKey,
      preview_status: "ready",
    })

    const res = await app.request(`/v1/og/${short_id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")

    // Body must be the exact PNG bytes we stored.
    const buf = await res.arrayBuffer()
    expect(new Uint8Array(buf)).toEqual(TINY_PNG)
  })

  it("SECURITY: private artifact with ready preview → anonymous caller gets SVG, never the PNG", async () => {
    const { app, meta, blobs } = makeApp("og-private-anon")
    // Upload as the static token (owner), then the anonymous caller has no token.
    const { short_id, current_version } = await publish(app, "<h1>Secret</h1>", {
      visibility: "org",
      title: "Private Artifact",
    })

    // Resolve the internal artifact id (not returned by the publish API).
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")

    // Mark preview as ready with a real PNG in the blob store.
    const pngKey = await blobs.put(TINY_PNG)
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: pngKey,
      preview_status: "ready",
    })

    // Anonymous request (no Authorization header) — same app instance, same stores.
    const anonApp = createApp({
      meta,
      blobs,
      baseUrl: "http://derive.test",
      token: TOKEN,
    })
    const res = await anonApp.request(`/v1/og/${short_id}`) // no auth header
    expect(res.status).toBe(200)
    // Must still be SVG — the locked card, not the PNG.
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const body = await res.text()
    expect(body).toContain("<svg")
    expect(body).not.toContain("Private Artifact")
  })
})
