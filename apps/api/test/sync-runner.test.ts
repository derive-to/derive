import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, type RepoSourceRecord, type SyncProgress } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { isSyncing, runToCompletion } from "../src/lib/sync-runner"

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

// isSyncing only reads `.progress`, so a narrow stub is enough to unit-test it.
const withProgress = (progress: string | null): RepoSourceRecord =>
  ({ progress }) as unknown as RepoSourceRecord
const prog = (phase: SyncProgress["phase"]): string =>
  JSON.stringify({ phase, done: 1, total: 2, updatedAt: "2026-06-14T00:00:00.000Z" })

describe("sync runner", () => {
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

  it("runToCompletion is a no-op when the source is gone (disconnected mid-sync)", async () => {
    await expect(
      runToCompletion(meta, blobStore, undefined, "rs_does_not_exist"),
    ).resolves.toBeUndefined()
  })

  it("isSyncing is true only for the in-flight phases", () => {
    expect(isSyncing(withProgress(prog("queued")))).toBe(true)
    expect(isSyncing(withProgress(prog("listing")))).toBe(true)
    expect(isSyncing(withProgress(prog("mirroring")))).toBe(true)
    expect(isSyncing(withProgress(prog("done")))).toBe(false)
    expect(isSyncing(withProgress(prog("error")))).toBe(false)
    expect(isSyncing(withProgress(null))).toBe(false)
    expect(isSyncing(withProgress("not json"))).toBe(false)
  })
})
