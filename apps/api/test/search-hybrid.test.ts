import type { ArtifactRecord, SearchIndex, VersionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import {
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
import {
  type VectorizeLike,
  VectorizeSearchIndex,
  type WorkersAiLike,
} from "../src/search-vectorize"

// Hybrid (lexical FTS + dense/semantic) workspace search. These are pure-logic tests over the
// fusion + orchestration and the Cloudflare adapter — with in-memory fakes for both the FTS arm
// and the dense arm, so the Vectorize/Workers-AI wiring itself is what's deployment-verified, but
// the RRF fusion, the recall-gap fix, the visibility gate over the new arm, and the adapter's
// embed/filter/preview contract are all pinned here. The existing lexical-only behavior is proven
// unchanged (no SearchIndex bound ⇒ byte-for-byte the old path) in mcp/search-rest.

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
      unindexArtifact: async () => {},
      search: async () => {
        throw new Error("vectorize unavailable")
      },
    }
    const { results } = await run(makeDeps([doc], boom), "onboarding")
    expect(results.map((r) => r.short_id)).toEqual(["onb1"]) // the lexical hit still comes back
  })
})

// --- The Cloudflare adapter, over fake Vectorize + Workers AI bindings ------------------------

const makeAi = () => {
  const runs: { model: string; text: string[]; truncate?: boolean }[] = []
  const ai: WorkersAiLike = {
    run: async (model, inputs) => {
      runs.push({ model, text: inputs.text, truncate: inputs.truncate_inputs })
      return { data: inputs.text.map(() => [0.1, 0.2, 0.3]) }
    },
  }
  return { ai, runs }
}

const makeVectorize = () => {
  const store = new Map<string, { values: number[]; metadata?: Record<string, string> }>()
  const seen = { deletes: [] as string[][], queries: [] as Parameters<VectorizeLike["query"]>[1][] }
  const vectorize: VectorizeLike = {
    upsert: async (vectors) => {
      for (const v of vectors) store.set(v.id, { values: v.values, metadata: v.metadata })
    },
    deleteByIds: async (ids) => {
      seen.deletes.push(ids)
      for (const id of ids) store.delete(id)
    },
    query: async (_vector, opts) => {
      seen.queries.push(opts)
      const org = opts.filter?.org_id
      const matches = [...store.entries()]
        .filter(([, v]) => org === undefined || v.metadata?.org_id === org)
        .slice(0, opts.topK ?? 10)
        .map(([id, v]) => ({ id, score: 0.5, metadata: v.metadata as Record<string, unknown> }))
      return { matches }
    },
  }
  return { vectorize, store, seen }
}

describe("VectorizeSearchIndex (Cloudflare adapter)", () => {
  it("indexArtifact embeds title+body and upserts one vector with org_id + preview metadata", async () => {
    const { vectorize, store } = makeVectorize()
    const { ai, runs } = makeAi()
    await new VectorizeSearchIndex(vectorize, ai).indexArtifact(
      "a1",
      "org1",
      "Onboarding",
      "the golden path",
    )
    expect(runs[0]?.model).toBe("@cf/baai/bge-m3")
    expect(runs[0]?.text).toEqual(["Onboarding\n\nthe golden path"]) // title prepended for the embed
    expect(runs[0]?.truncate).toBe(true) // over-limit (long/CJK) inputs trim instead of throwing
    expect(store.get("a1")?.metadata?.org_id).toBe("org1")
    expect(store.get("a1")?.metadata?.preview).toContain("Onboarding")
  })

  it("search embeds the query, filters by org_id, requests metadata, and maps preview → chunk", async () => {
    const { vectorize, seen } = makeVectorize()
    const { ai } = makeAi()
    const idx = new VectorizeSearchIndex(vectorize, ai)
    await idx.indexArtifact("a1", "org1", "Onboarding", "the golden path")
    await idx.indexArtifact("a2", "org2", "Other", "a different workspace")
    const hits = await idx.search("org1", "getting started", 6)
    expect(hits.map((h) => h.id)).toEqual(["a1"]) // org filter excludes the other workspace
    expect(hits[0]?.chunk).toContain("Onboarding")
    expect(seen.queries[0]?.filter).toEqual({ org_id: "org1" })
    expect(seen.queries[0]?.returnMetadata).toBe("all")
    expect(seen.queries[0]?.topK).toBe(6)
  })

  it("unindex deletes the vector; empty content unindexes instead of upserting", async () => {
    const { vectorize, store, seen } = makeVectorize()
    const { ai } = makeAi()
    const idx = new VectorizeSearchIndex(vectorize, ai)
    await idx.indexArtifact("a1", "org1", "T", "body")
    expect(store.has("a1")).toBe(true)
    await idx.unindexArtifact("a1")
    expect(store.has("a1")).toBe(false)
    // A non-text artifact (empty indexable content) must not upsert — and drops any prior vector.
    await idx.indexArtifact("a2", "org1", null, "   ")
    expect(store.has("a2")).toBe(false)
    expect(seen.deletes).toContainEqual(["a2"])
  })

  it("search with a blank query short-circuits without calling the model", async () => {
    const { vectorize } = makeVectorize()
    const { ai, runs } = makeAi()
    expect(await new VectorizeSearchIndex(vectorize, ai).search("org1", "   ", 6)).toEqual([])
    expect(runs).toHaveLength(0)
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
    const search: SearchIndex = {
      indexArtifact: async (id) => {
        dense.push(id)
      },
      unindexArtifact: async () => {},
      search: async () => [],
    }
    const res = await reindexSearchBatch({ meta, blobs, search }, { limit: 10 })
    expect(dense).toEqual(["a", "b"])
    expect(res.indexed).toBe(2)
  })
})
