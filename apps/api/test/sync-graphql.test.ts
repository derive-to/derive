import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, type RepoSourceRecord } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchBlobsBatch } from "../src/lib/github"
import { runSync } from "../src/lib/sync"

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

const dir = mkdtempSync(join(tmpdir(), "dock-sync-gql-"))
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
// own fetch (e.g. the 502 case) can't leak into the next one.
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

  it("dedups identical shas and makes no request for an empty list", async () => {
    blobs["dup"] = "x"
    const out = await fetchBlobsBatch({ owner: "o", name: "n" }, ["dup", "dup", "dup"], "tok")
    expect(out.size).toBe(1)
    expect(await fetchBlobsBatch({ owner: "o", name: "n" }, [], "tok")).toEqual(new Map())
    expect(graphqlCalls).toBe(1) // only the first call hit the network
  })

  it("returns empty (→ REST fallback) on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    )
    const out = await fetchBlobsBatch({ owner: "o", name: "n" }, ["z"], "tok")
    expect(out.size).toBe(0)
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
