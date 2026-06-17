import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, type RepoSourceRecord, type SyncProgress } from "@dock/core"
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
// repo path → the last-commit date the Commits API reports for it.
const commitDates: Record<string, string> = {}

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
      if (s.includes("/commits?")) {
        const path = new URL(s).searchParams.get("path") ?? ""
        const date = commitDates[path]
        return new Response(JSON.stringify(date ? [{ commit: { committer: { date } } }] : []), {
          status: 200,
        })
      }
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
    expect(res).toEqual({ added: 2, updated: 0, removed: 0, renamed: 0, skipped: 0, remaining: 0 })

    const ids = await meta.collectionArtifactIds(source.collection_id)
    expect(ids).toHaveLength(2)
    const managed = await meta.managedArtifactIds("local")
    expect(managed.sort()).toEqual([...ids].sort())

    const map = fileMap(await reload())
    expect(Object.keys(map).sort()).toEqual(["docs/intro.md", "guide.html"])
    // The markdown file keeps its repo path as the title.
    const art = await meta.getByShortId(map["docs/intro.md"]?.short_id ?? "")
    // Title now comes from the doc's heading ("# Intro"); the path lives in source_path.
    expect(art?.title).toBe("Intro")
    expect(art?.source_path).toBe("docs/intro.md")
  })

  it("re-sync with no changes: everything skipped, no new versions", async () => {
    source = await reload()
    const res = await runSync(meta, blobStore, source, NOW)
    expect(res).toEqual({ added: 0, updated: 0, removed: 0, renamed: 0, skipped: 2, remaining: 0 })
  })

  it("changed file (new sha): appends a version, doesn't duplicate the artifact", async () => {
    source = await reload()
    const before = fileMap(source)["docs/intro.md"]
    tree = tree.map((e) => (e.path === "docs/intro.md" ? { ...e, sha: "sha-intro-2" } : e))
    blobs["sha-intro-2"] = "# Intro v2"

    const res = await runSync(meta, blobStore, source, NOW)
    expect(res).toEqual({ added: 0, updated: 1, removed: 0, renamed: 0, skipped: 1, remaining: 0 })

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
    expect(art?.title).toBe("A") // content unchanged → title stays
    expect(art?.source_path).toBe("b.md") // location moved to the new path
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

  it("extracts a human title from content and keeps the path in source_path", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "titles",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/titles",
      ref: "main",
      includes: "**/*.md,**/*.html",
      created_by: "u",
    })
    tree = [
      { path: "docs/plans/foo.md", sha: "t-md", type: "blob" },
      { path: "page.html", sha: "t-html", type: "blob" },
      { path: "notitle.md", sha: "t-plain", type: "blob" },
    ]
    blobs["t-md"] = "---\nx: 1\n---\n# Taxonomy System\n\nbody"
    blobs["t-html"] = "<html><head><title>The Page</title></head><body><h1>x</h1></body></html>"
    blobs["t-plain"] = "no heading here, just prose"
    await runSync(meta, blobStore, src, NOW)
    const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as FileMap
    const md = await meta.getByShortId(map["docs/plans/foo.md"]?.short_id ?? "")
    expect(md?.title).toBe("Taxonomy System")
    expect(md?.source_path).toBe("docs/plans/foo.md")
    const html = await meta.getByShortId(map["page.html"]?.short_id ?? "")
    expect(html?.title).toBe("The Page")
    const plain = await meta.getByShortId(map["notitle.md"]?.short_id ?? "")
    expect(plain?.title).toBe("notitle") // no heading → basename without extension
  })

  it("caps each run at maxFiles and finishes a large repo across batches", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "big",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/big",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    tree = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.md`,
      sha: `big-${i}`,
      type: "blob" as const,
    }))
    for (let i = 0; i < 5; i++) blobs[`big-${i}`] = `# F${i}`
    const limits = { maxBytes: 1e9, maxFiles: 2, overStorage: async () => false }

    let r = await runSync(meta, blobStore, src, NOW, limits)
    expect(r).toMatchObject({ added: 2, remaining: 3 }) // first batch bounded
    let guard = 0
    while (r.remaining > 0 && guard++ < 10) {
      const s = await meta.getRepoSource(src.id)
      if (!s) throw new Error("gone")
      r = await runSync(meta, blobStore, s, NOW, limits)
    }
    expect(r.remaining).toBe(0)
    const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as FileMap
    expect(Object.keys(map).length).toBe(5) // every file mirrored, no duplicates
  })

  // ---- Source date → artifact.updated_at -------------------------------
  it("stamps updated_at from the source file's last-commit date, and backfills legacy entries", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "dates",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/dates",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    tree = [{ path: "dated.md", sha: "dt-1", type: "blob" }]
    blobs["dt-1"] = "# Dated"
    commitDates["dated.md"] = "2025-01-02T03:04:05Z"

    const load = async () => (await meta.getRepoSource(src.id)) as RepoSourceRecord

    // Forward: a freshly published file carries the SOURCE date, not the sync `NOW`.
    await runSync(meta, blobStore, src, NOW)
    const map = JSON.parse((await load()).files) as FileMap
    const sid = map["dated.md"]?.short_id as string
    expect((await meta.getByShortId(sid))?.updated_at).toBe("2025-01-02T03:04:05Z")
    expect(map["dated.md"]?.updatedAt).toBe("2025-01-02T03:04:05Z")

    // Backfill: simulate a legacy entry synced before dates existed (updatedAt absent)
    // by stripping it from the map + resetting the row, then re-sync (sha unchanged).
    const legacy = { ...map["dated.md"] } as SyncedFile
    legacy.updatedAt = undefined
    await meta.updateRepoSourceSync(src.id, {
      files: JSON.stringify({ "dated.md": legacy }),
      last_synced_at: NOW,
      last_status: "ok",
    })
    await meta.setArtifactUpdatedAt(legacy.artifact_id, NOW) // wrong (ingest-time) date
    commitDates["dated.md"] = "2024-09-09T09:09:09Z"
    await runSync(meta, blobStore, await load(), NOW)
    expect((await meta.getByShortId(sid))?.updated_at).toBe("2024-09-09T09:09:09Z")
  })

  // ---- Live progress (the giant UI bar reads this) ----------------------
  // setRepoSourceProgress is always called with a JSON string by the engine.
  const progressPhases = (calls: [string, string | null][]): SyncProgress[] =>
    calls.map(([, json]) => JSON.parse(json ?? "{}") as SyncProgress)

  it("writes pollable progress through the phases (listing → mirroring → done)", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "prog",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/prog",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    tree = [
      { path: "a.md", sha: "pg-a", type: "blob" },
      { path: "b.md", sha: "pg-b", type: "blob" },
    ]
    blobs["pg-a"] = "# A"
    blobs["pg-b"] = "# B"
    const spy = vi.spyOn(meta, "setRepoSourceProgress")
    await runSync(meta, blobStore, src, NOW)
    const phases = progressPhases(spy.mock.calls)
    spy.mockRestore()
    // Fresh source → first a "listing" (before the count is known), then "mirroring",
    // then a terminal "done" carrying the full count.
    expect(phases[0]?.phase).toBe("listing")
    expect(phases.some((p) => p.phase === "mirroring")).toBe(true)
    const last = phases.at(-1)
    expect(last).toMatchObject({ phase: "done", done: 2, total: 2 })
  })

  it("progress is monotonic across batches (never snaps backward)", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "mono",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/mono",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    tree = Array.from({ length: 5 }, (_, i) => ({
      path: `m${i}.md`,
      sha: `mono-${i}`,
      type: "blob" as const,
    }))
    for (let i = 0; i < 5; i++) blobs[`mono-${i}`] = `# M${i}`
    const limits = { maxBytes: 1e9, maxFiles: 2, overStorage: async () => false }
    const spy = vi.spyOn(meta, "setRepoSourceProgress")
    let s = (await meta.getRepoSource(src.id)) as RepoSourceRecord
    let r = await runSync(meta, blobStore, s, NOW, limits)
    let guard = 0
    while (r.remaining > 0 && guard++ < 10) {
      s = (await meta.getRepoSource(src.id)) as RepoSourceRecord
      r = await runSync(meta, blobStore, s, NOW, limits)
    }
    const dones = progressPhases(spy.mock.calls).map((p) => p.done)
    spy.mockRestore()
    // The floor at the carried-forward count means `done` never drops between the
    // batches — without it the bar would snap 2→0→4→0 at each batch's listTree.
    for (let i = 1; i < dones.length; i++)
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1] as number)
    expect(dones.at(-1)).toBe(5)
  })

  it("error path sets progress phase=error", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "perr",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/perr",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    tree = [{ path: "z.md", sha: "perr-z", type: "blob" }]
    delete blobs["perr-z"] // missing blob → fetchBlob 404 → runSync throws
    await expect(runSync(meta, blobStore, src, NOW)).rejects.toThrow()
    const prog = JSON.parse(
      (await meta.getRepoSource(src.id))?.progress ?? "null",
    ) as SyncProgress | null
    expect(prog?.phase).toBe("error")
  })

  // Safety: a one-way mirror must not wipe a collection because a single listing
  // came back wrong (transient error / bad branch / momentarily-empty tree that
  // isn't flagged truncated). A run that would tombstone a large fraction of the
  // tracked files withholds the removals and flags it — nothing is lost.
  it("mass-removal guard: a suspect (tiny) listing withholds removals", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "GitHub: acme/big",
      created_by: "u1",
    })
    let src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/big",
      ref: "main",
      includes: "**/*.md",
      created_by: "u1",
    })
    // First sync: 15 docs.
    tree = Array.from({ length: 15 }, (_, i) => ({
      path: `d${i}.md`,
      sha: `big-${i}`,
      type: "blob" as const,
    }))
    for (let i = 0; i < 15; i++) blobs[`big-${i}`] = `# Doc ${i}`
    expect((await runSync(meta, blobStore, src, NOW)).added).toBe(15)
    src = (await meta.getRepoSource(src.id)) as RepoSourceRecord

    // Next listing returns only 1 file (not truncated) — would tombstone 14/15.
    tree = [{ path: "d0.md", sha: "big-0", type: "blob" }]
    const res = await runSync(meta, blobStore, src, NOW)

    // Removals withheld, not applied.
    expect(res.removed).toBe(0)
    expect(res.removalsSkipped).toBe(14)
    // All 15 artifacts survive (none tombstoned) and stay tracked in the map.
    const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as FileMap
    expect(Object.keys(map).filter((p) => /^d\d+\.md$/.test(p)).length).toBe(15)
    const live = await meta.listArtifacts({ orgId: "local" })
    const myIds = new Set(Object.values(map).map((e) => e.artifact_id))
    expect(live.filter((a) => myIds.has(a.id) && a.removed_at).length).toBe(0) // none tombstoned

    // A SMALL removal (below the floor) still tombstones normally: drop one file.
    src = (await meta.getRepoSource(src.id)) as RepoSourceRecord
    tree = Array.from({ length: 14 }, (_, i) => ({
      path: `d${i}.md`,
      sha: `big-${i}`,
      type: "blob" as const,
    })) // d14 removed
    const res2 = await runSync(meta, blobStore, src, NOW)
    expect(res2.removed).toBe(1)
    expect(res2.removalsSkipped).toBeUndefined()
  })
})
