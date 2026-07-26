import type { Embedder } from "@derive/core"
import type { VectorMatch, VectorRow, VectorStore } from "@derive/db/pgvector"
import { describe, expect, it } from "vitest"
import {
  bindingEmbedder,
  EMBED_BATCH,
  restEmbedder,
  WorkersAiEmbedder,
  type WorkersAiLike,
} from "../src/embedder"
import { PgvectorSearchIndex } from "../src/search-pgvector"

// --- fakes ---------------------------------------------------------------------------------------

const makeStore = () => {
  const rows = new Map<string, VectorRow>()
  const deletes: string[][] = []
  const deletedArtifacts: string[] = []
  let queryResult: VectorMatch[] = []
  const store: VectorStore = {
    upsert: async (rs) => {
      for (const r of rs) rows.set(r.vectorId, r)
    },
    deleteByIds: async (ids) => {
      deletes.push(ids)
      for (const id of ids) rows.delete(id)
    },
    deleteByArtifact: async (id) => {
      deletedArtifacts.push(id)
      for (const [k, r] of [...rows]) if (r.artifactId === id) rows.delete(k)
    },
    query: async () => queryResult,
  }
  return {
    store,
    rows,
    deletes,
    deletedArtifacts,
    setQuery: (r: VectorMatch[]) => (queryResult = r),
  }
}

// Deterministic embedder: one dim-4 vector per input, distinct per position. Records its calls.
const makeEmbedder = (dim = 4) => {
  const calls: string[][] = []
  const embedder: Embedder = {
    model: "fake-embedder",
    dimensions: dim,
    minScore: 0.48,
    embed: async (texts) => {
      calls.push(texts)
      return texts.map((_, i) => Array.from({ length: dim }, (_, d) => (i + d + 1) / 100))
    },
  }
  return { embedder, calls }
}

// --- WorkersAiEmbedder ---------------------------------------------------------------------------

describe("WorkersAiEmbedder", () => {
  it("groups inputs into EMBED_BATCH sub-batches, preserving order", async () => {
    const batches: string[][] = []
    const emb = new WorkersAiEmbedder(async (texts) => {
      batches.push(texts)
      return texts.map(() => [0.1, 0.2])
    })
    const n = EMBED_BATCH + 3
    const out = await emb.embed(Array.from({ length: n }, (_, i) => `t${i}`))
    expect(out).toHaveLength(n)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(EMBED_BATCH)
    expect(batches[1]).toEqual([`t${EMBED_BATCH}`, `t${EMBED_BATCH + 1}`, `t${EMBED_BATCH + 2}`])
  })

  it("throws (not misaligns) when the backend returns a wrong count", async () => {
    const emb = new WorkersAiEmbedder(async () => [[0.1]]) // 1 vector for N inputs
    await expect(emb.embed(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2/)
  })

  it("bindingEmbedder passes truncate_inputs to the Workers AI binding", async () => {
    const seen: { model: string; text: string[]; truncate?: boolean }[] = []
    const ai: WorkersAiLike = {
      run: async (model, inputs) => {
        seen.push({ model, text: inputs.text, truncate: inputs.truncate_inputs })
        return { data: inputs.text.map(() => [0.1, 0.2, 0.3]) }
      },
    }
    const out = await bindingEmbedder(ai).embed(["hello"])
    expect(out).toEqual([[0.1, 0.2, 0.3]])
    expect(seen[0]?.model).toBe("@cf/baai/bge-m3")
    expect(seen[0]?.truncate).toBe(true)
  })

  it("restEmbedder posts to the Workers AI REST endpoint with a bearer token", async () => {
    let calledUrl = ""
    let calledAuth = ""
    let calledBody: unknown
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calledUrl = url
      calledAuth = (init.headers as Record<string, string>).authorization ?? ""
      calledBody = JSON.parse(init.body as string)
      return { ok: true, json: async () => ({ result: { data: [[0.4, 0.5]] } }) }
    }) as unknown as typeof fetch
    const out = await restEmbedder("acct123", "tok456", fakeFetch).embed(["q"])
    expect(out).toEqual([[0.4, 0.5]])
    expect(calledUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/baai/bge-m3",
    )
    expect(calledAuth).toBe("Bearer tok456")
    expect(calledBody).toEqual({ text: ["q"], truncate_inputs: true })
  })

  it("restEmbedder throws on a non-ok response, including the body", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "rate limit exceeded",
    })) as unknown as typeof fetch
    await expect(restEmbedder("a", "t", fakeFetch).embed(["q"])).rejects.toThrow(
      /429.*rate limit exceeded/,
    )
  })
})

// --- PgvectorSearchIndex -------------------------------------------------------------------------

describe("PgvectorSearchIndex", () => {
  it("indexArtifact chunks, embeds title+chunk, upserts a row per chunk, clears stale slots", async () => {
    const { store, rows, deletes } = makeStore()
    const { embedder, calls } = makeEmbedder()
    await new PgvectorSearchIndex(embedder, store).indexArtifact(
      "a1",
      "o1",
      "Onboarding",
      "the golden path",
    )
    expect(calls[0]).toEqual(["Onboarding\n\nthe golden path"]) // title prepended
    const row = rows.get("a1#0")
    expect(row?.artifactId).toBe("a1")
    expect(row?.orgId).toBe("o1")
    expect(row?.chunk).toBe(0)
    expect(row?.snippet).toBe("the golden path")
    expect(row?.embedding).toHaveLength(4)
    // stale sweep deletes bare id + chunk slots >= kept count (1)
    const deleted = deletes.flat()
    expect(deleted).toContain("a1")
    expect(deleted).toContain("a1#1")
    expect(deleted).not.toContain("a1#0") // the kept chunk survives
  })

  it("a long doc writes multiple chunk rows; re-indexing shorter clears the extra slots", async () => {
    const { store, rows } = makeStore()
    const { embedder } = makeEmbedder()
    const idx = new PgvectorSearchIndex(embedder, store)
    await idx.indexArtifact("a1", "o1", null, "para ".repeat(1500)) // ~7.5k chars → several chunks
    expect([...rows.keys()].filter((k) => k.startsWith("a1#")).length).toBeGreaterThan(1)
    await idx.indexArtifact("a1", "o1", null, "short")
    expect([...rows.keys()].filter((k) => k.startsWith("a1#"))).toEqual(["a1#0"])
  })

  it("empty content upserts nothing and clears the artifact's slots", async () => {
    const { store, rows, deletes } = makeStore()
    const { embedder, calls } = makeEmbedder()
    await new PgvectorSearchIndex(embedder, store).indexArtifact("a1", "o1", null, "   ")
    expect(rows.size).toBe(0)
    expect(calls).toHaveLength(0) // nothing embedded
    expect(deletes.flat()).toContain("a1")
  })

  it("indexArtifacts batches chunks across artifacts and clears each one's stale slots", async () => {
    const { store, rows, deletes } = makeStore()
    const { embedder, calls } = makeEmbedder()
    await new PgvectorSearchIndex(embedder, store).indexArtifacts([
      { id: "a1", orgId: "o1", title: "T1", text: "one" },
      { id: "a2", orgId: "o1", title: null, text: "two" },
    ])
    expect(rows.has("a1#0")).toBe(true)
    expect(rows.has("a2#0")).toBe(true)
    expect(calls[0]).toEqual(["T1\n\none", "two"]) // both embedded in one flat call
    expect(deletes.flat()).toEqual(expect.arrayContaining(["a1", "a2"]))
  })

  it("unindexArtifact drops all of an artifact's vectors by artifact id", async () => {
    const { store, rows, deletedArtifacts } = makeStore()
    const { embedder } = makeEmbedder()
    const idx = new PgvectorSearchIndex(embedder, store)
    await idx.indexArtifact("a1", "o1", null, "body")
    await idx.unindexArtifact("a1")
    expect(deletedArtifacts).toContain("a1")
    expect(rows.size).toBe(0)
  })

  it("search embeds the query, rolls chunks up to the best per artifact, applies the floor", async () => {
    const { store, setQuery } = makeStore()
    const { embedder, calls } = makeEmbedder()
    setQuery([
      { artifactId: "a1", chunk: "the best chunk", score: 0.7 },
      { artifactId: "a1", chunk: "weaker chunk", score: 0.6 },
      { artifactId: "a2", chunk: "other doc", score: 0.55 },
      { artifactId: "a3", chunk: "below floor", score: 0.3 },
    ])
    const hits = await new PgvectorSearchIndex(embedder, store).search("o1", "getting started", 6)
    expect(calls[0]).toEqual(["getting started"]) // query embedded
    expect(hits.map((h) => h.id)).toEqual(["a1", "a2"]) // best-per-artifact, a3 dropped by floor
    expect(hits[0]).toEqual({ id: "a1", score: 0.7, chunk: "the best chunk" })
  })

  it("a blank query short-circuits without embedding or querying", async () => {
    const { store } = makeStore()
    const { embedder, calls } = makeEmbedder()
    expect(await new PgvectorSearchIndex(embedder, store).search("o1", "   ", 6)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("throws (not misaligns) if the embedder returns a wrong vector count for a chunk group", async () => {
    const { store, rows } = makeStore()
    // Embedder returns ONE vector regardless of input count — a broken/misaligned response.
    const badEmbedder: Embedder = {
      model: "bad",
      dimensions: 4,
      minScore: 0.48,
      embed: async () => [[0.1, 0.2, 0.3, 0.4]],
    }
    await expect(
      new PgvectorSearchIndex(badEmbedder, store).indexArtifacts([
        { id: "a1", orgId: "o1", title: null, text: "one" },
        { id: "a2", orgId: "o1", title: null, text: "two" },
      ]),
    ).rejects.toThrow(/returned 1 vectors for 2 chunks/)
    expect(rows.size).toBe(0) // nothing stored on a misaligned batch
  })
})
