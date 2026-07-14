import type { ArtifactRecord, SearchIndex, VersionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import {
  deleteArtifactAndUnindex,
  indexArtifactVersion,
  reindexSearchBatch,
  rrfFuse,
  searchMatcher,
  searchWorkspace,
  toSearchHits,
  type WorkspaceSearchDeps,
  type WorkspaceSearchResult,
  workspaceSearchReport,
} from "../src/lib/search"
import { CHUNK_CHARS, CHUNK_OVERLAP, chunkText, MAX_CHUNKS } from "../src/search-chunk"

// Hybrid (lexical FTS + dense/semantic) workspace search. These are pure-logic tests over the
// fusion + orchestration — with in-memory fakes for both the FTS arm and the dense SearchIndex, so
// the RRF fusion, the recall-gap fix, and the visibility gate over the dense arm are pinned here
// independent of any backend. The concrete adapters are tested separately (search-pgvector.test.ts +
// the real-pgvector store test in @derive/db); chunk-level logic lives in search-chunk. The existing
// lexical-only behavior is proven unchanged (no SearchIndex bound ⇒ byte-for-byte the old path).

const ORG = "org_test"
const enc = (s: string) => new TextEncoder().encode(s)

interface Doc {
  id: string
  short_id: string
  title: string
  body: string
  org_id?: string
  workspace_access?: "member" | "none"
}

// A partial ArtifactRecord is castable because ArtifactRecord is assignable to it (same trick the
// existing tests use for VersionRecord): only real fields the search path reads are set.
const artifact = (d: Doc): ArtifactRecord =>
  ({
    id: d.id,
    short_id: d.short_id,
    title: d.title,
    current_version: 1,
    org_id: d.org_id ?? ORG,
    workspace_access: d.workspace_access ?? "member",
    password_hash: null,
  }) as ArtifactRecord

// A stand-in FTS arm: AND'd case-insensitive substring match over title+body (looser than real
// fts5 prefix, but the same "nominate, then the caller grep-confirms the literal" contract).
const lexical = (docs: Doc[], orgId: string, query: string, limit: number) => {
  const toks = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (!toks.length) return []
  return docs
    .filter((d) => (d.org_id ?? ORG) === orgId)
    .filter((d) => {
      const hay = `${d.title}\n${d.body}`.toLowerCase()
      return toks.every((t) => hay.includes(t))
    })
    .slice(0, limit)
    .map((d, i) => ({ id: d.id, rank: -i }))
}

// A stand-in dense arm: a fixed query→hits table, with NO visibility knowledge (by design) — the
// Tier-2 gate is what enforces visibility over whatever this nominates.
const denseIndex = (
  byQuery: Record<string, { id: string; score: number; chunk: string }[]>,
): SearchIndex => ({
  indexArtifact: async () => {},
  indexArtifacts: async () => {},
  unindexArtifact: async () => {},
  search: async (_org, query, limit) => (byQuery[query] ?? []).slice(0, limit),
})

const makeDeps = (docs: Doc[], search?: SearchIndex): WorkspaceSearchDeps => {
  const keyOf = (d: Doc) => `blob_${d.id}`
  const bodyForKey = (key: string) => docs.find((d) => keyOf(d) === key)?.body ?? null
  const version = (d: Doc) =>
    ({ blob_key: keyOf(d), content_type: "text/markdown" }) as VersionRecord
  return {
    blobs: {
      get: async (key: string) => {
        const b = bodyForKey(key)
        return b === null ? null : enc(b)
      },
      put: async () => "unused",
    },
    sourceText: async (v) => bodyForKey(v.blob_key),
    meta: {
      listArtifacts: async (opts) => {
        const ids = new Set(opts.ids ?? [])
        return (
          docs
            .filter((d) => ids.has(d.id))
            .filter((d) => (d.org_id ?? ORG) === opts.orgId)
            // Minimal visibility: a workspace_access:"none" doc is hidden from a publicOnly (anon)
            // caller — enough to prove the gate governs the dense arm's nominations too.
            .filter((d) => !(opts.publicOnly && (d.workspace_access ?? "member") === "none"))
            .map(artifact)
        )
      },
      getVersion: async (id: string) => {
        const d = docs.find((x) => x.id === id)
        return d ? version(d) : null
      },
      searchArtifactIds: async (orgId, query, limit) => lexical(docs, orgId, query, limit),
    },
    search,
  }
}

const run = (
  deps: WorkspaceSearchDeps,
  query: string,
  extra: { publicOnly?: boolean; viewerId?: string } = {},
) =>
  searchWorkspace(deps, {
    orgId: ORG,
    query,
    re: searchMatcher(query, false),
    where: "text",
    ctxLines: 0,
    cap: 40,
    ...extra,
  })

describe("rrfFuse", () => {
  it("ranks an id present in BOTH arms above one in either alone, and carries the dense chunk", () => {
    const fused = rrfFuse(
      [{ id: "b" }, { id: "a" }],
      [
        { id: "a", chunk: "A-chunk" },
        { id: "c", chunk: "C-chunk" },
      ],
      10,
    )
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]) // a in both ⇒ top; then b, c by rank
    expect(fused.find((f) => f.id === "a")?.chunk).toBe("A-chunk")
    expect(fused.find((f) => f.id === "b")?.chunk).toBeUndefined() // lexical-only ⇒ no chunk
  })

  it("honours the limit", () => {
    expect(rrfFuse([{ id: "a" }, { id: "b" }], [], 1)).toHaveLength(1)
  })
})

describe("searchWorkspace — hybrid retrieval", () => {
  const onboarding: Doc = {
    id: "onb",
    short_id: "onb1",
    title: "Onboarding",
    body: "# Onboarding\n\nthe golden path for new users to reach the aha moment",
  }

  it("dense arm surfaces a paraphrase the lexical arm MISSES (the recall gap) — lexical-only returns nothing", async () => {
    const q = "getting started" // a synonym for onboarding; absent from the text literally
    // Lexical-only (no SearchIndex): the paraphrase finds nothing — the gap seen live on prod.
    const lexOnly = await run(makeDeps([onboarding]), q)
    expect(lexOnly.results).toHaveLength(0)
    // Hybrid: the dense arm nominates the doc; it survives with a semantic snippet from its chunk.
    const dense = denseIndex({
      "getting started": [{ id: "onb", score: 0.9, chunk: "the golden path for new users" }],
    })
    const hybrid = await run(makeDeps([onboarding], dense), q)
    expect(hybrid.results.map((r) => r.short_id)).toEqual(["onb1"])
    expect(hybrid.results[0]?.total).toBe(0) // no literal hunks — it's a semantic match
    expect(hybrid.results[0]?.semantic?.snippet).toContain("golden path")
  })

  it("a literal match renders identically whether or not a dense arm is bound (lexical path unchanged)", async () => {
    const doc: Doc = {
      id: "onb",
      short_id: "onb1",
      title: "Onboarding",
      body: "onboarding is the golden path",
    }
    const withDense = await run(makeDeps([doc], denseIndex({})), "onboarding")
    const without = await run(makeDeps([doc]), "onboarding")
    for (const r of [withDense, without]) {
      expect(r.results.map((x) => x.short_id)).toEqual(["onb1"])
      expect(r.results[0]?.total).toBeGreaterThan(0) // literal grep hunks
      expect(r.results[0]?.semantic).toBeUndefined()
    }
  })

  it("the Tier-2 visibility gate drops a dense-nominated artifact the viewer can't see (no leak via the new arm)", async () => {
    const secret: Doc = {
      id: "priv",
      short_id: "priv1",
      title: "Secret",
      body: "the roadmap internals nobody outside should read",
      workspace_access: "none",
    }
    const dense = denseIndex({
      "future plans": [{ id: "priv", score: 0.95, chunk: "the roadmap internals" }],
    })
    // Anonymous (publicOnly): the dense arm nominates it, the gate drops it — nothing leaks.
    const anon = await run(makeDeps([secret], dense), "future plans", { publicOnly: true })
    expect(anon.results).toHaveLength(0)
    // A member (not publicOnly) can see it, so the semantic hit surfaces for them.
    const member = await run(makeDeps([secret], dense), "future plans", { viewerId: "u1" })
    expect(member.results.map((r) => r.short_id)).toEqual(["priv1"])
  })

  it("toSearchHits (⌘K palette) uses the chunk as the snippet for a semantic-only hit", async () => {
    const dense = denseIndex({
      "getting started": [{ id: "onb", score: 0.9, chunk: "the golden path for new users" }],
    })
    const { results } = await run(makeDeps([onboarding], dense), "getting started")
    const hits = toSearchHits(results, "getting started")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.snippet).toContain("golden path")
  })

  it("a throwing dense arm degrades to lexical-only rather than failing the whole search", async () => {
    const doc: Doc = {
      id: "onb",
      short_id: "onb1",
      title: "Onboarding",
      body: "onboarding is the golden path",
    }
    const boom: SearchIndex = {
      indexArtifact: async () => {},
      indexArtifacts: async () => {},
      unindexArtifact: async () => {},
      search: async () => {
        throw new Error("vectorize unavailable")
      },
    }
    const { results } = await run(makeDeps([doc], boom), "onboarding")
    expect(results.map((r) => r.short_id)).toEqual(["onb1"]) // the lexical hit still comes back
  })
})

describe("chunkText", () => {
  it("returns one trimmed chunk for short text, [] for blank", () => {
    expect(chunkText("  hello world  ")).toEqual(["hello world"])
    expect(chunkText("   ")).toEqual([])
  })
  it("splits long text into multiple chunks, each within CHUNK_CHARS, capped at MAX_CHUNKS", () => {
    const chunks = chunkText("lorem ipsum ".repeat(2000)) // ~24k chars
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS)
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0)
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS)
    }
  })
  it("caps a very long doc at MAX_CHUNKS (tail dropped)", () => {
    expect(chunkText("word ".repeat(200_000)).length).toBe(MAX_CHUNKS)
  })
  it("overlaps consecutive chunks by CHUNK_OVERLAP so a boundary-spanning match is never split", () => {
    // No-whitespace text: no break adjustment/trim, so the overlap is exact and assertable.
    const t = "abcdefghij".repeat(500) // 5000 chars, no spaces → deterministic windows
    const chunks = chunkText(t)
    expect(chunks.length).toBeGreaterThan(2)
    for (let i = 0; i < chunks.length - 1; i++)
      expect(chunks[i]?.slice(-CHUNK_OVERLAP)).toBe(chunks[i + 1]?.slice(0, CHUNK_OVERLAP))
  })
})

describe("workspaceSearchReport — semantic rendering", () => {
  const lit = (short_id: string, title: string, total: number): WorkspaceSearchResult => ({
    short_id,
    title,
    current_version: 1,
    total,
    groups: [
      { path: null, hunks: [{ from: 1, lines: [{ n: 1, text: `hit for ${title}`, hit: true }] }] },
    ],
  })
  const sem = (short_id: string, title: string, snippet: string): WorkspaceSearchResult => ({
    short_id,
    title,
    current_version: 1,
    total: 0,
    groups: [],
    semantic: { snippet },
  })

  it("all-semantic result set reports a semantic-match count (not '0 matches') and renders the chunk", () => {
    const out = workspaceSearchReport(
      "getting started",
      "text",
      [sem("onb1", "Onboarding", "the golden path")],
      null,
    )
    expect(out).toContain("1 semantic match")
    expect(out).not.toMatch(/\b0 match/)
    expect(out).toContain("## onb1 — Onboarding  (semantic match)")
    expect(out).toContain("the golden path")
  })

  it("mixed literal + semantic keeps the literal-count header and renders both shapes", () => {
    const out = workspaceSearchReport(
      "x",
      "text",
      [lit("a1", "A", 2), sem("b1", "B", "chunk B")],
      null,
    )
    expect(out).toContain("2 matches for")
    expect(out).toContain("## a1 — A\n")
    expect(out).toContain("## b1 — B  (semantic match)")
    expect(out).toContain("chunk B")
  })

  it("empty results → the no-matches line", () => {
    expect(workspaceSearchReport("q", "text", [], null)).toContain("No matches")
  })
})

describe("write path — dense arm best-effort + backfill", () => {
  it("indexArtifactVersion: a throwing dense arm neither blocks the lexical upsert nor throws", async () => {
    const lexed: string[] = []
    const meta = {
      indexArtifact: async (id: string) => {
        lexed.push(id)
      },
    }
    const blobs = { get: async () => enc("# T\n\nbody"), put: async () => "k" }
    const v = { blob_key: "k", content_type: "text/markdown" } as VersionRecord
    const boom = {
      indexArtifact: async () => {
        throw new Error("vectorize down")
      },
    }
    await expect(
      indexArtifactVersion(meta, blobs, { id: "a", org_id: ORG, title: "T" }, v, boom),
    ).resolves.toBeUndefined()
    expect(lexed).toEqual(["a"]) // lexical committed despite the dense failure
  })

  it("reindexSearchBatch: backfill embeds each artifact into the dense arm too", async () => {
    const dense: string[] = []
    const arts = [
      { id: "a", current_version: 1, org_id: ORG, title: "A", created_at: "t1" },
      { id: "b", current_version: 1, org_id: ORG, title: "B", created_at: "t2" },
    ] as ArtifactRecord[]
    const meta = {
      indexArtifact: async () => {},
      listArtifacts: async () => arts,
      getVersion: async () => ({ blob_key: "k", content_type: "text/markdown" }) as VersionRecord,
    }
    const blobs = { get: async () => enc("body"), put: async () => "k" }
    let denseCalls = 0
    const search: SearchIndex = {
      indexArtifact: async () => {},
      // backfill uses the BATCH path now — record the ids, and count the calls
      indexArtifacts: async (items) => {
        denseCalls++
        dense.push(...items.map((i) => i.id))
      },
      unindexArtifact: async () => {},
      search: async () => [],
    }
    const res = await reindexSearchBatch({ meta, blobs, search }, { limit: 10 })
    expect(denseCalls).toBe(1) // ONE batched dense call for the page, not one per artifact
    expect(dense).toEqual(["a", "b"])
    expect(res.indexed).toBe(2)
  })

  it("deleteArtifactAndUnindex drops BOTH arms — the FTS row (in deleteArtifact) and the dense vector", async () => {
    const deleted: [string, string][] = []
    const unindexed: string[] = []
    const meta = {
      deleteArtifact: async (id: string, org: string) => {
        deleted.push([id, org])
      },
    }
    const search = {
      unindexArtifact: async (id: string) => {
        unindexed.push(id)
      },
    }
    await deleteArtifactAndUnindex(meta, search, "a1", ORG)
    expect(deleted).toEqual([["a1", ORG]])
    expect(unindexed).toEqual(["a1"]) // the dense vector is dropped too, not just the FTS row
  })

  it("deleteArtifactAndUnindex: a throwing dense arm neither blocks the DB delete nor throws", async () => {
    const deleted: string[] = []
    const meta = {
      deleteArtifact: async (id: string) => {
        deleted.push(id)
      },
    }
    const boom = {
      unindexArtifact: async () => {
        throw new Error("dense down")
      },
    }
    await expect(deleteArtifactAndUnindex(meta, boom, "a1", ORG)).resolves.toBeUndefined()
    expect(deleted).toEqual(["a1"]) // the DB delete committed despite the dense failure
  })

  it("deleteArtifactAndUnindex with no dense arm bound just deletes (no throw)", async () => {
    let deleted = false
    const meta = {
      deleteArtifact: async () => {
        deleted = true
      },
    }
    await expect(deleteArtifactAndUnindex(meta, undefined, "a1", ORG)).resolves.toBeUndefined()
    expect(deleted).toBe(true)
  })
})
