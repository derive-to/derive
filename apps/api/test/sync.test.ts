import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, type RepoSourceRecord } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runSync, type SyncedFile } from "../src/lib/sync"

type FileMap = Record<string, SyncedFile>

// A controllable fake of one GitHub repo: the tree the API returns and the raw
// bytes per blob sha. Tests mutate these between sync runs to model commits.
let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
let truncated = false
const blobs: Record<string, string> = {}

const dir = mkdtempSync(join(tmpdir(), "dock-sync-test-"))
const meta = new SqliteMetaStore(join(dir, "sync.db"))
const blobStore = new FsBlobStore(join(dir, "blobs"))
const NOW = "2026-06-14T00:00:00.000Z"

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.includes("/git/trees/"))
        return new Response(JSON.stringify({ tree, truncated }), { status: 200 })
      const m = s.match(/\/git\/blobs\/([^/?]+)/)
      if (m) {
        const body = blobs[m[1] as string]
        return body == null
          ? new Response("not found", { status: 404 })
          : new Response(body, { status: 200 })
      }
      return new Response("nope", { status: 404 })
    }),
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("GitHub sync engine", () => {
  let source: RepoSourceRecord
  const reload = async (): Promise<RepoSourceRecord> => {
    const s = await meta.getRepoSource(source.id)
    if (!s) throw new Error("source vanished")
    return s
  }
  const fileMap = (s: RepoSourceRecord) =>
    JSON.parse(s.files) as Record<string, { artifact_id: string; short_id: string; sha: string }>

  it("sets up a source pointed at a collection", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "GitHub: acme/docs",
      created_by: "u1",
    })
    source = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/docs",
      ref: "main",
      includes: "**/*.md,**/*.html",
      created_by: "u1",
    })
    expect(source.files).toBe("{}")
  })

  it("first sync: mirrors the matching docs, skips non-matching files", async () => {
    tree = [
      { path: "docs/intro.md", sha: "sha-intro-1", type: "blob" },
      { path: "guide.html", sha: "sha-guide-1", type: "blob" },
      { path: "logo.png", sha: "sha-logo", type: "blob" }, // not md/html → ignored
    ]
    blobs["sha-intro-1"] = "# Intro"
    blobs["sha-guide-1"] = "<h1>Guide</h1>"

    const res = await runSync(meta, blobStore, source, NOW)
    expect(res).toEqual({ added: 2, updated: 0, removed: 0, renamed: 0, skipped: 0 })

    const ids = await meta.collectionArtifactIds(source.collection_id)
    expect(ids).toHaveLength(2)
    const managed = await meta.managedArtifactIds("local")
    expect(managed.sort()).toEqual([...ids].sort())

    const map = fileMap(await reload())
    expect(Object.keys(map).sort()).toEqual(["docs/intro.md", "guide.html"])
    // The markdown file keeps its repo path as the title.
    const art = await meta.getByShortId(map["docs/intro.md"]?.short_id ?? "")
    expect(art?.title).toBe("docs/intro.md")
  })

  it("re-sync with no changes: everything skipped, no new versions", async () => {
    source = await reload()
    const res = await runSync(meta, blobStore, source, NOW)
    expect(res).toEqual({ added: 0, updated: 0, removed: 0, renamed: 0, skipped: 2 })
  })

  it("changed file (new sha): appends a version, doesn't duplicate the artifact", async () => {
    source = await reload()
    const before = fileMap(source)["docs/intro.md"]
    tree = tree.map((e) => (e.path === "docs/intro.md" ? { ...e, sha: "sha-intro-2" } : e))
    blobs["sha-intro-2"] = "# Intro v2"

    const res = await runSync(meta, blobStore, source, NOW)
    expect(res).toEqual({ added: 0, updated: 1, removed: 0, renamed: 0, skipped: 1 })

    const after = fileMap(await reload())["docs/intro.md"]
    expect(after?.artifact_id).toBe(before?.artifact_id) // same artifact
    const versions = await meta.listVersions(before?.artifact_id ?? "")
    expect(versions).toHaveLength(2) // first publish + the synced change
  })

  it("deleted file: tombstones the artifact (410), keeps the record", async () => {
    source = await reload()
    const guideId = fileMap(source)["guide.html"]?.artifact_id ?? ""
    tree = tree.filter((e) => e.path !== "guide.html")

    const res = await runSync(meta, blobStore, source, NOW)
    expect(res.removed).toBe(1)

    const tombstoned = (await meta.listArtifacts({ orgId: "local" })).find((a) => a.id === guideId)
    expect(tombstoned?.removed_at).toBeTruthy()
    // It's no longer in the live file map.
    expect(fileMap(await reload())["guide.html"]).toBeUndefined()
    // managedArtifactIds now only counts the surviving doc.
    expect(await meta.managedArtifactIds("local")).toHaveLength(1)
  })

  it("truncated tree: never tombstones (absent ≠ deleted)", async () => {
    source = await reload()
    truncated = true
    tree = [] // pretend GitHub returned nothing usable
    const res = await runSync(meta, blobStore, source, NOW)
    expect(res.removed).toBe(0)
    // The surviving doc is carried forward, not dropped.
    expect(Object.keys(fileMap(await reload()))).toContain("docs/intro.md")
    truncated = false
  })

  // #4 — a pure rename (path moves, content identical → same git sha) must reuse
  // the existing artifact (keeping its comment history), not tombstone + recreate.
  it("pure rename: re-homes the artifact (same id, retitled), no duplicate", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "rename",
      created_by: "u",
    })
    const s0 = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/rename",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    tree = [{ path: "a.md", sha: "rn-1", type: "blob" }]
    blobs["rn-1"] = "# A"
    await runSync(meta, blobStore, s0, NOW)
    const s1 = await meta.getRepoSource(s0.id)
    if (!s1) throw new Error("gone")
    const artId = (JSON.parse(s1.files) as FileMap)["a.md"]?.artifact_id

    // Move a.md → b.md, same sha (pure rename).
    tree = [{ path: "b.md", sha: "rn-1", type: "blob" }]
    const res = await runSync(meta, blobStore, s1, NOW)
    expect(res).toMatchObject({ added: 0, removed: 0, renamed: 1 })

    const s2 = await meta.getRepoSource(s0.id)
    if (!s2) throw new Error("gone")
    const map = JSON.parse(s2.files) as FileMap
    expect(map["a.md"]).toBeUndefined()
    expect(map["b.md"]?.artifact_id).toBe(artId) // same artifact, comments intact
    const art = await meta.getByShortId(map["b.md"]?.short_id ?? "")
    expect(art?.title).toBe("b.md") // retitled to the new path
    expect(art?.removed_at).toBeFalsy() // not tombstoned
  })

  // #1 — a mid-run failure must persist the partial map so a retry treats the
  // already-mirrored files as updates, never re-publishing duplicates.
  it("mid-run failure: persists progress, retry doesn't duplicate", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "partial",
      created_by: "u",
    })
    const s0 = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/partial",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    // x.md publishes fine; y.md's blob is missing → fetchBlob 404 → runSync throws
    // *after* x is already published.
    tree = [
      { path: "x.md", sha: "pf-x", type: "blob" },
      { path: "y.md", sha: "pf-y", type: "blob" },
    ]
    blobs["pf-x"] = "# X"
    delete blobs["pf-y"]
    await expect(runSync(meta, blobStore, s0, NOW)).rejects.toThrow()

    const s1 = await meta.getRepoSource(s0.id)
    if (!s1) throw new Error("gone")
    const map1 = JSON.parse(s1.files) as FileMap
    expect(map1["x.md"]).toBeDefined() // x recorded despite the throw
    expect(s1.last_status?.startsWith("error")).toBe(true)
    const xId = map1["x.md"]?.artifact_id

    // Fix y and retry: x is unchanged (skipped, NOT re-added), y is added.
    blobs["pf-y"] = "# Y"
    const res = await runSync(meta, blobStore, s1, NOW)
    expect(res).toMatchObject({ added: 1, skipped: 1 })
    const s2 = await meta.getRepoSource(s0.id)
    if (!s2) throw new Error("gone")
    expect((JSON.parse(s2.files) as FileMap)["x.md"]?.artifact_id).toBe(xId) // same artifact
  })
})
