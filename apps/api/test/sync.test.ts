import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BundleManifest, newId, type RepoSourceRecord, type SyncProgress } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import { planBundle, resolveRef } from "../src/lib/bundle-from-repo"
import { fetchBlobsBatch } from "../src/lib/github"
import { runSync, type SyncedFile } from "../src/lib/sync"
import { runToCompletion } from "../src/lib/sync-runner"

type FileMap = Record<string, SyncedFile>

// A controllable fake of one GitHub repo: the tree the API returns and the raw
// bytes per blob sha. Tests mutate these between sync runs to model commits.
let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
let truncated = false
const blobs: Record<string, string> = {}
// repo path → the last-commit date the Commits API reports for it.
const commitDates: Record<string, string> = {}

const dir = mkdtempSync(join(tmpdir(), "derive-sync-test-"))
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

  // A source pointed at a collection; the first five cases below sync it in turn.
  beforeAll(async () => {
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
    // This mock returns only a committer date (no author) → the author falls back to the
    // legacy "GitHub sync" display name and the GitHub fields stay null. The author is
    // marked sourced so a re-sync won't re-fetch.
    expect((await meta.getByShortId(sid))?.author_name).toBe("GitHub sync")
    expect((await meta.getByShortId(sid))?.author_login).toBeNull()
    expect(map["dated.md"]?.authorSourced).toBe(true)

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

// ---------------------------------------------------------------------------
// The runner above the engine: runToCompletion keeps calling runSync until the
// whole repo is mirrored, so a large repo lands server-side whether or not the
// tab that started it stays open.
describe("sync runner", () => {
  // Same controllable fake GitHub as the engine test: a tree + raw bytes per sha.
  let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
  const blobs: Record<string, string> = {}

  const dir = mkdtempSync(join(tmpdir(), "derive-sync-runner-test-"))
  const meta = new SqliteMetaStore(join(dir, "runner.db"))
  const blobStore = new FsBlobStore(join(dir, "blobs"))

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

  it("runToCompletion loops batches until the whole repo is mirrored", async () => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: "loop",
      created_by: "u",
    })
    const src = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo: "acme/loop",
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
    // 60 docs > the 50/batch cap, so this only finishes if the runner loops past the
    // first batch (the tab-independence guarantee: every file lands server-side).
    tree = Array.from({ length: 60 }, (_, i) => ({
      path: `l${i}.md`,
      sha: `loop-${i}`,
      type: "blob" as const,
    }))
    for (let i = 0; i < 60; i++) blobs[`loop-${i}`] = `# L${i}`

    await runToCompletion(meta, blobStore, undefined, src.id)

    const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as Record<
      string,
      unknown
    >
    expect(Object.keys(map)).toHaveLength(60) // all mirrored despite the per-batch cap
    const progress = JSON.parse(
      (await meta.getRepoSource(src.id))?.progress ?? "null",
    ) as SyncProgress | null
    expect(progress).toMatchObject({ phase: "done", done: 60, total: 60 })
  })
})

// ---------------------------------------------------------------------------
// The bundle planner the engine consumes: a reference that escapes the repo
// root is refused (path traversal), and planBundle gathers the HTML's refs plus
// one level of CSS, rooted at the members' common ancestor.
describe("bundle planner", () => {
  describe("resolveRef", () => {
    it("returns null when the reference escapes the repo root or is empty", () => {
      expect(resolveRef("docs", "../../etc/passwd")).toBeNull()
      expect(resolveRef("", "  ")).toBeNull()
    })
  })

  describe("planBundle", () => {
    const tree = new Set([
      "docs/page.html",
      "docs/style.css",
      "shared/reset.css",
      "shared/fonts/inter.woff2",
      "docs/logo.png",
    ])
    const has = (p: string) => tree.has(p)
    const files: Record<string, string> = {
      "docs/style.css": `@import "../shared/reset.css"; body{background:url(logo.png)}`,
      "shared/reset.css": `@font-face{src:url(fonts/inter.woff2)}`,
    }
    const fetchText = async (p: string) => files[p] ?? null

    it("returns null when the HTML references no local assets", async () => {
      expect(await planBundle("docs/page.html", "<h1>hi</h1>", has, fetchText)).toBeNull()
      // External-only refs don't count.
      const ext = `<link href="https://cdn/x.css"><img src="data:image/png;base64,AA">`
      expect(await planBundle("docs/page.html", ext, has, fetchText)).toBeNull()
    })

    it("gathers HTML refs + one level of CSS, rooted at the common ancestor", async () => {
      const html = `<link rel="stylesheet" href="style.css"><img src="logo.png">`
      const plan = await planBundle("docs/page.html", html, has, fetchText)
      expect(plan).not.toBeNull()
      const paths = plan?.members.map((m) => m.repoPath).sort()
      // page + its css + img, plus the css's @import and the reset's @font-face (1 level).
      expect(paths).toEqual([
        "docs/logo.png",
        "docs/page.html",
        "docs/style.css",
        "shared/fonts/inter.woff2",
        "shared/reset.css",
      ])
      // Rooted at repo root (page is under docs/, reset under shared/).
      expect(plan?.root).toBe("")
      expect(plan?.entryRel).toBe("docs/page.html")
      const rel = Object.fromEntries(plan?.members.map((m) => [m.repoPath, m.rel]) ?? [])
      expect(rel["docs/style.css"]).toBe("docs/style.css")
    })
  })
})

// ---------------------------------------------------------------------------
// Bundle-aware sync: an HTML page plus the local assets it references mirrors
// as ONE bundle artifact, re-syncs when any member changes (composite sha), and
// shares content-addressed blobs across bundles.
describe("bundle-aware sync (HTML + referenced assets)", () => {
  // Same controllable fake repo as the engine test: a tree + raw bytes per blob sha.
  let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
  const blobs: Record<string, string> = {}

  const dir = mkdtempSync(join(tmpdir(), "derive-sync-bundle-"))
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
})

// ---------------------------------------------------------------------------
// The GraphQL batch fast path: one request fetches every text blob, and the
// engine falls back to per-blob REST only for what GraphQL won't return as text.
describe("GraphQL batch fast path", () => {
  // A fake GitHub that serves the GraphQL batch endpoint (the fast path) AND the REST
  // tree + blob endpoints (the fallback). `blobs` maps git-sha -> content; `binaryShas`
  // are returned by GraphQL as binary (no text) so the engine must fall back to REST for
  // them. `restBlobCalls` counts REST per-blob GETs, so a test can assert the batch path
  // was used (zero) or the fallback fired (>0).
  let tree: { path: string; sha: string; type: "blob"; size?: number }[] = []
  const blobs: Record<string, string> = {}
  const binaryShas = new Set<string>()
  let restBlobCalls = 0
  let graphqlCalls = 0

  const dir = mkdtempSync(join(tmpdir(), "derive-sync-gql-"))
  const meta = new SqliteMetaStore(join(dir, "gql.db"))
  const blobStore = new FsBlobStore(join(dir, "blobs"))
  const NOW = "2026-06-16T00:00:00.000Z"

  const fakeGitHub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const s = String(url)
    if (s.includes("/graphql")) {
      graphqlCalls++
      const query = (JSON.parse(String(init?.body)) as { query: string }).query
      const aliases: Record<string, unknown> = {}
      for (const m of query.matchAll(/a(\d+):object\(oid:"([^"]+)"\)/g)) {
        const idx = m[1]
        const sha = m[2] as string
        aliases[`a${idx}`] =
          blobs[sha] === undefined
            ? null
            : binaryShas.has(sha)
              ? { text: null, isBinary: true }
              : { text: blobs[sha], isBinary: false }
      }
      return new Response(JSON.stringify({ data: { repository: aliases } }), { status: 200 })
    }
    if (s.includes("/git/trees/"))
      return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 })
    const m = s.match(/\/git\/blobs\/([^/?]+)/)
    if (m) {
      restBlobCalls++
      const b = blobs[m[1] as string]
      return b == null ? new Response("nf", { status: 404 }) : new Response(b, { status: 200 })
    }
    return new Response("nf", { status: 404 })
  }

  // Re-apply the fake (and reset counters) before every test, so a test that stubs its
  // own fetch can't leak into the next one.
  beforeEach(() => {
    restBlobCalls = 0
    graphqlCalls = 0
    vi.stubGlobal("fetch", vi.fn(fakeGitHub))
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const newSource = async (repo: string): Promise<RepoSourceRecord> => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "local",
      title: repo,
      created_by: "u",
    })
    return meta.createRepoSource({
      id: newId("rs"),
      org_id: "local",
      collection_id: col.id,
      repo,
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
  }

  describe("fetchBlobsBatch", () => {
    it("returns sha->bytes for text blobs in ONE request; omits binary + missing", async () => {
      blobs["g-a"] = "# Hello"
      binaryShas.add("g-b")
      blobs["g-b"] = "PNGDATA"
      // g-c intentionally absent
      const out = await fetchBlobsBatch({ owner: "o", name: "n" }, ["g-a", "g-b", "g-c"], "tok")
      expect(graphqlCalls).toBe(1) // one request for three blobs
      expect(new TextDecoder().decode(out.get("g-a") as Uint8Array)).toBe("# Hello")
      expect(out.has("g-b")).toBe(false) // binary omitted → caller uses REST
      expect(out.has("g-c")).toBe(false) // missing omitted
      binaryShas.delete("g-b")
    })
  })

  describe("runSync via GraphQL batch", () => {
    it("mirrors every doc through the batch with ZERO per-blob REST fetches", async () => {
      const src = await newSource("acme/gql")
      tree = [
        { path: "docs/a.md", sha: "s-a", type: "blob", size: 7 },
        { path: "docs/b.md", sha: "s-b", type: "blob", size: 7 },
        { path: "readme.md", sha: "s-r", type: "blob", size: 9 },
      ]
      blobs["s-a"] = "# Alpha"
      blobs["s-b"] = "# Bravo"
      blobs["s-r"] = "# Readme!"

      const res = await runSync(meta, blobStore, src, NOW)
      expect(res.added).toBe(3)
      expect(restBlobCalls).toBe(0) // all content came from the GraphQL batch
      expect(graphqlCalls).toBeGreaterThanOrEqual(1)
      // Titles were extracted from the GraphQL-delivered text.
      const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as Record<
        string,
        { short_id: string }
      >
      const a = await meta.getByShortId(map["docs/a.md"]?.short_id ?? "")
      expect(a?.title).toBe("Alpha")
    })

    it("falls back to REST for a blob GraphQL won't return as text", async () => {
      const src = await newSource("acme/gql-bin")
      tree = [
        { path: "ok.md", sha: "b-ok", type: "blob", size: 5 },
        { path: "weird.md", sha: "b-bin", type: "blob", size: 5 },
      ]
      blobs["b-ok"] = "# Ok"
      blobs["b-bin"] = "# Weird" // present, but GraphQL reports it binary
      binaryShas.add("b-bin")

      const res = await runSync(meta, blobStore, src, NOW)
      expect(res.added).toBe(2) // both still mirrored
      expect(restBlobCalls).toBe(1) // exactly the one GraphQL skipped
      binaryShas.delete("b-bin")
    })
  })
})

// ---------------------------------------------------------------------------
// GitHub author tracking: the commit author is captured at sync time (login and
// gh_id stamped on both the version and the artifact, with fallbacks when GitHub
// maps no account), artifactIdsByAuthor is scoped to the org, usersByGithubIds
// resolves an account row to its Derive user, and a byline frozen as "Derive CLI"
// by a pre-fix publish heals to the live user on read.
describe("GitHub author tracking", () => {
  // ---- GitHub repo fake (one repo's tree + blobs + last-commit per path) ------
  let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
  // repo path → the commit element the Commits API returns (date + authors).
  const commits: Record<
    string,
    {
      commit?: { committer?: { date?: string }; author?: { name?: string; email?: string } }
      author?: { login?: string; id?: number; avatar_url?: string } | null
    }
  > = {}
  const blobs: Record<string, string> = {}

  const dir = mkdtempSync(join(tmpdir(), "derive-author-test-"))
  const dbPath = join(dir, "a.db")
  const meta = new SqliteMetaStore(dbPath)
  const blobStore = new FsBlobStore(join(dir, "blobs"))
  const app = createApp({ meta, blobs: blobStore, baseUrl: "http://derive.test", token: "tok" })
  const NOW = "2026-06-17T00:00:00.000Z"
  const auth = { authorization: "Bearer tok" }

  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const s = String(url)
        if (s.includes("/git/trees/"))
          return new Response(JSON.stringify({ tree, truncated: false }))
        if (s.includes("/commits?")) {
          const path = new URL(s).searchParams.get("path") ?? ""
          const c = commits[path]
          return new Response(JSON.stringify(c ? [c] : []))
        }
        const m = s.match(/\/git\/blobs\/([^/?]+)/)
        if (m) {
          const body = blobs[m[1] as string]
          return body == null ? new Response("nf", { status: 404 }) : new Response(body)
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

  const mkSource = async (repo: string): Promise<RepoSourceRecord> => {
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "default",
      title: repo,
      created_by: "u",
    })
    return meta.createRepoSource({
      id: newId("rs"),
      org_id: "default",
      collection_id: col.id,
      repo,
      ref: "main",
      includes: "**/*.md",
      created_by: "u",
    })
  }

  describe("sync capture", () => {
    it("stamps the commit author on both the version and the artifact", async () => {
      const src = await mkSource("acme/repo-a")
      tree = [{ path: "intro.md", sha: "sha-a-1", type: "blob" }]
      blobs["sha-a-1"] = "# Intro"
      commits["intro.md"] = {
        commit: {
          committer: { date: "2025-05-05T05:05:05Z" },
          author: { name: "Ada Lovelace", email: "ada@example.com" },
        },
        author: { login: "ada", id: 4242, avatar_url: "https://avatars/ada.png" },
      }

      await runSync(meta, blobStore, src, NOW)

      const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as Record<
        string,
        { artifact_id: string; short_id: string; authorSourced?: boolean; updatedAt?: string }
      >
      const ent = map["intro.md"]
      expect(ent?.authorSourced).toBe(true)
      expect(ent?.updatedAt).toBe("2025-05-05T05:05:05Z")

      // Artifact: denormalized current author + date.
      const art = await meta.getByShortId(ent?.short_id ?? "")
      expect(art?.author_name).toBe("ada") // display name prefers the login
      expect(art?.author_login).toBe("ada")
      expect(art?.author_gh_id).toBe("4242")
      expect(art?.author_avatar).toBe("https://avatars/ada.png")
      expect(art?.updated_at).toBe("2025-05-05T05:05:05Z")

      // Version row: the GitHub identity is stored per-version too.
      const v = await meta.getVersion(art?.id ?? "", 1)
      expect(v?.author).toBe("ada")
      expect(v?.author_login).toBe("ada")
      expect(v?.author_gh_id).toBe("4242")
    })

    it("falls back to the git author name (then 'GitHub sync') when GitHub maps no account", async () => {
      const src = await mkSource("acme/repo-b")
      tree = [
        { path: "named.md", sha: "sha-b-1", type: "blob" },
        { path: "bare.md", sha: "sha-b-2", type: "blob" },
      ]
      blobs["sha-b-1"] = "# Named"
      blobs["sha-b-2"] = "# Bare"
      // A commit with a git author name but no resolved GitHub account.
      commits["named.md"] = {
        commit: {
          committer: { date: "2024-02-02T02:02:02Z" },
          author: { name: "Grace Hopper", email: "grace@example.com" },
        },
        author: null,
      }
      // No identity at all → keep the legacy "GitHub sync" display name.
      commits["bare.md"] = { commit: { committer: { date: "2024-03-03T03:03:03Z" } } }

      await runSync(meta, blobStore, src, NOW)
      const map = JSON.parse((await meta.getRepoSource(src.id))?.files ?? "{}") as Record<
        string,
        { short_id: string }
      >

      const named = await meta.getByShortId(map["named.md"]?.short_id ?? "")
      expect(named?.author_name).toBe("Grace Hopper")
      expect(named?.author_login).toBeNull()
      expect(named?.author_gh_id).toBeNull()

      const bare = await meta.getByShortId(map["bare.md"]?.short_id ?? "")
      expect(bare?.author_name).toBe("GitHub sync")
      expect(bare?.author_login).toBeNull()
    })
  })

  describe("model + list filter", () => {
    it("artifactIdsByAuthor filters by login (case-insensitive), scoped to the org", async () => {
      // Two artifacts authored by "ada" already exist from repo-a; publish one by another
      // login + one in another org to prove scoping + login matching.
      const other = await meta.createArtifact({
        id: newId("a"),
        short_id: newId("s"),
        org_id: "default",
        slug: null,
        title: "by-bob",
        workspace_access: "member",
        link_role: "viewer",
        listed: "public",
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(other.id, {
        id: newId("v"),
        blob_key: await blobStore.put(new TextEncoder().encode("x")),
        content_type: "text/markdown",
        size_bytes: 1,
        author: "bob",
        author_login: "bob",
        author_avatar: null,
        author_gh_id: "9001",
        message: null,
      })

      const ada = await meta.artifactIdsByAuthor("default", "ADA") // case-insensitive
      expect(ada.length).toBe(1)
      const bob = await meta.artifactIdsByAuthor("default", "bob")
      expect(bob).toEqual([other.id])
      expect(await meta.artifactIdsByAuthor("default", "nobody")).toEqual([])
      expect(await meta.artifactIdsByAuthor("other-org", "ada")).toEqual([])
    })
  })

  describe("user mapping", () => {
    it("usersByGithubIds maps an account row to its Derive user", async () => {
      // Seed Better Auth's user + account tables directly via the raw sqlite handle.
      const raw = new Database(dbPath)
      raw.exec(
        `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
      )
      raw.exec(
        `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT)`,
      )
      raw
        .prepare(`INSERT OR IGNORE INTO user (id, name, image, username) VALUES (?,?,?,?)`)
        .run("u-ada", "Ada L.", "https://img/ada", "ada-handle")
      raw
        .prepare(
          `INSERT OR IGNORE INTO account (id, accountId, providerId, userId) VALUES (?,?,?,?)`,
        )
        .run("acc-1", "4242", "github", "u-ada")
      raw.close()

      const rows = await meta.usersByGithubIds(["4242", "9999"])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        gh_id: "4242",
        id: "u-ada",
        username: "ada-handle",
        name: "Ada L.",
        image: "https://img/ada",
      })

      // The single-artifact API resolves the handle onto the author profile.
      const ada = (await meta.artifactIdsByAuthor("default", "ada"))[0] as string
      const art = await meta.getArtifactById(ada)
      const detail = await (
        await app.request(`/v1/artifacts/${art?.short_id}`, { headers: auth })
      ).json()
      expect(detail.author).toMatchObject({ login: "ada", handle: "ada-handle" })
      expect(detail.versions[0]).toMatchObject({ author_login: "ada", handle: "ada-handle" })
    })
  })

  describe("self-healing bylines — a stale byline resolves to the live user", () => {
    it("an old version frozen as 'Derive CLI' reads as its author_id user on read", async () => {
      // A Derive account exists (Better Auth's user table).
      const raw = new Database(dbPath)
      raw.exec(
        `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
      )
      raw
        .prepare(`INSERT OR IGNORE INTO user (id, email, name, username) VALUES (?,?,?,?)`)
        .run("u_cli", "maya@x.test", "Maya Iyer", "maya")
      raw.close()

      // Simulate a pre-fix CLI publish: the byline string is frozen as the OAuth client name,
      // but author_id already points at the human (what makes it show under "created by me").
      const art = await meta.createArtifact({
        id: newId("a"),
        short_id: newId("s"),
        org_id: "default",
        slug: null,
        title: "CLI doc",
        workspace_access: "member",
        link_role: "viewer",
        listed: "public",
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(art.id, {
        id: newId("v"),
        blob_key: await blobStore.put(new TextEncoder().encode("<h1>x</h1>")),
        content_type: "text/html",
        size_bytes: 1,
        author: "Derive CLI", // the stale frozen byline
        author_id: "u_cli", // the truth — denormalized onto the artifact too
        message: null,
      })

      const detail = await (
        await app.request(`/v1/artifacts/${art.short_id}`, { headers: auth })
      ).json()
      // Both the version byline and the current-author profile heal to the live user.
      expect(detail.versions[0].author).toBe("Maya Iyer")
      expect(detail.versions[0].handle).toBe("maya")
      expect(detail.author).toMatchObject({ name: "Maya Iyer", handle: "maya" })

      // And the list view heals the same way (no stale name on the card).
      const list = await (await app.request("/v1/artifacts?limit=100", { headers: auth })).json()
      const row = list.artifacts.find((a: { short_id: string }) => a.short_id === art.short_id)
      expect(row.author).toMatchObject({ name: "Maya Iyer", handle: "maya" })
    })
  })
})
