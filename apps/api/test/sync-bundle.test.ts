import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BundleManifest, newId } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runSync, type SyncedFile } from "../src/lib/sync"

// Same controllable fake repo as sync.test.ts: a tree + raw bytes per blob sha.
let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
const blobs: Record<string, string> = {}

const dir = mkdtempSync(join(tmpdir(), "dock-sync-bundle-"))
const meta = new SqliteMetaStore(join(dir, "sync.db"))
const blobStore = new FsBlobStore(join(dir, "blobs"))
const NOW = "2026-06-15T00:00:00.000Z"

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.includes("/git/trees/"))
        return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 })
      const m = s.match(/\/git\/blobs\/([^/?]+)/)
      if (m) {
        const body = blobs[m[1] as string]
        return body == null
          ? new Response("nf", { status: 404 })
          : new Response(body, { status: 200 })
      }
      return new Response("nf", { status: 404 })
    }),
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const fileMap = (files: string) => JSON.parse(files) as Record<string, SyncedFile>
const manifestOf = async (shortId: string): Promise<BundleManifest> => {
  const art = await meta.getByShortId(shortId)
  if (!art) throw new Error("no artifact")
  const v = (await meta.listVersions(art.id)).at(-1)
  if (!v) throw new Error("no version")
  const bytes = await blobStore.get(v.blob_key)
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as BundleManifest
}

describe("bundle-aware sync (HTML + referenced assets)", () => {
  let source: Awaited<ReturnType<typeof meta.createRepoSource>>
  const setup = async (includes = "**/*.html,**/*.md") => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "GitHub: acme/site",
      created_by: "u1",
    })
    return meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/site",
      ref: "main",
      includes,
      created_by: "u1",
    })
  }

  it("mirrors an HTML page that references a local CSS as one bundle", async () => {
    source = await setup()
    tree = [
      { path: "docs/page.html", sha: "h1", type: "blob" },
      { path: "docs/style.css", sha: "c1", type: "blob" },
    ]
    blobs.h1 = `<html><head><link rel="stylesheet" href="style.css"></head><body>hi</body></html>`
    blobs.c1 = `body{color:rebeccapurple}`

    const res = await runSync(meta, blobStore, source, NOW)
    // One artifact added (the bundle); the CSS is NOT a standalone artifact.
    expect(res.added).toBe(1)
    const ids = await meta.collectionArtifactIds(source.collection_id)
    expect(ids).toHaveLength(1)

    const map = fileMap((await meta.getRepoSource(source.id))?.files ?? "{}")
    // Only the HTML entry is a map key; the css is a bundle member, not its own row.
    expect(Object.keys(map)).toEqual(["docs/page.html"])
    expect(map["docs/page.html"]?.kind).toBe("bundle")
    expect(Object.keys(map["docs/page.html"]?.members ?? {}).sort()).toEqual([
      "docs/page.html",
      "docs/style.css",
    ])

    const art = await meta.getByShortId(map["docs/page.html"]?.short_id ?? "")
    expect(art?.kind).toBe("bundle")
    // The bundle serves the css at the path the HTML's relative ref resolves to.
    const manifest = await manifestOf(map["docs/page.html"]?.short_id ?? "")
    expect(manifest.files["/style.css"]).toBeDefined()
    expect(manifest.entry).toBe("/page.html")
  })

  it("re-syncs the page when its shared CSS changes (composite sha)", async () => {
    source = (await meta.getRepoSource(source.id)) ?? source
    // Page byte-identical; only the CSS changed → composite sha differs → republish.
    tree = tree.map((e) => (e.path === "docs/style.css" ? { ...e, sha: "c2" } : e))
    blobs.c2 = `body{color:teal}`

    const res = await runSync(meta, blobStore, source, NOW)
    expect(res).toMatchObject({ added: 0, updated: 1, skipped: 0 })

    // Unchanged re-run now skips (nothing moved).
    source = (await meta.getRepoSource(source.id)) ?? source
    expect(await runSync(meta, blobStore, source, NOW)).toMatchObject({ updated: 0, skipped: 1 })
  })

  it("deduplicates a CSS shared by two pages across their bundles", async () => {
    const src = await setup()
    tree = [
      { path: "a.html", sha: "ah", type: "blob" },
      { path: "b.html", sha: "bh", type: "blob" },
      { path: "shared.css", sha: "sh", type: "blob" },
    ]
    blobs.ah = `<link rel="stylesheet" href="shared.css">A`
    blobs.bh = `<link rel="stylesheet" href="shared.css">B`
    blobs.sh = `*{box-sizing:border-box}`

    const res = await runSync(meta, blobStore, src, NOW)
    expect(res.added).toBe(2) // two bundles
    const map = fileMap((await meta.getRepoSource(src.id))?.files ?? "{}")
    expect(Object.keys(map).sort()).toEqual(["a.html", "b.html"]) // css isn't standalone

    // Both bundles reference the SAME content-addressed blob for the shared CSS.
    const ma = await manifestOf(map["a.html"]?.short_id ?? "")
    const mb = await manifestOf(map["b.html"]?.short_id ?? "")
    expect(ma.files["/shared.css"]?.key).toBe(mb.files["/shared.css"]?.key)
  })

  it("leaves an HTML page with no local assets as a single file", async () => {
    const src = await setup()
    tree = [{ path: "plain.html", sha: "p1", type: "blob" }]
    blobs.p1 = `<html><body><a href="https://x.com">ext</a></body></html>`

    await runSync(meta, blobStore, src, NOW)
    const map = fileMap((await meta.getRepoSource(src.id))?.files ?? "{}")
    expect(map["plain.html"]?.kind).toBe("file")
    const art = await meta.getByShortId(map["plain.html"]?.short_id ?? "")
    expect(art?.kind).toBe("file")
  })
})
