import type { ArtifactRecord, SearchIndex, VersionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import {
  deleteArtifactAndUnindex,
  indexArtifactVersion,
  rrfFuse,
  searchMatcher,
  searchWorkspace,
  type WorkspaceSearchDeps,
} from "../src/lib/search"

// Hybrid (lexical FTS + dense/semantic) workspace search. These are pure-logic tests over the
// fusion + orchestration — with in-memory fakes for both the FTS arm and the dense SearchIndex, so
// the RRF fusion, the recall-gap fix, and the visibility gate over the dense arm are pinned here
// independent of any backend. The pgvector adapter is tested against a real Postgres in
// @derive/db; chunk-level logic lives in search-chunk. The existing lexical-only behavior is
// proven unchanged (no SearchIndex bound ⇒ byte-for-byte the old path).

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
      // The batched face of getVersion the grep-confirm pass uses (one query for the
      // whole candidate page instead of one per candidate).
      currentVersions: async (ids: string[]) => {
        const out: Record<string, VersionRecord> = {}
        for (const id of ids) {
          const d = docs.find((x) => x.id === id)
          if (d) out[id] = version(d)
        }
        return out
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

describe("write path — dense arm best-effort + backfill", () => {
  it("skips both index writes when an exact edit leaves the search projection unchanged", async () => {
    const lexical: string[] = []
    const dense: string[] = []
    const source = `${"a".repeat(300_000)}tail before`
    const edited = `${"a".repeat(300_000)}tail after`
    await indexArtifactVersion(
      {
        indexArtifact: async () => {
          lexical.push("lexical")
        },
      },
      { get: async () => null, put: async () => "unused" },
      { id: "a1", org_id: ORG, title: "Large" },
      { blob_key: "new", content_type: "text/html" } as VersionRecord,
      {
        indexArtifact: async () => {
          dense.push("dense")
        },
      },
      edited,
      { source, contentType: "text/html", title: "Large" },
    )
    expect(lexical).toEqual([])
    expect(dense).toEqual([])
  })

  it("updates both indexes when the bounded projection changes", async () => {
    const calls: string[] = []
    await indexArtifactVersion(
      {
        indexArtifact: async () => {
          calls.push("lexical")
        },
      },
      { get: async () => null, put: async () => "unused" },
      { id: "a1", org_id: ORG, title: "Large" },
      { blob_key: "new", content_type: "text/html" } as VersionRecord,
      {
        indexArtifact: async () => {
          calls.push("dense")
        },
      },
      "changed body",
      { source: "old body", contentType: "text/html", title: "Large" },
    )
    expect(calls).toEqual(["lexical", "dense"])
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
})
