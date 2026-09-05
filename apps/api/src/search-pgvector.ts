import type { Embedder, SearchIndex } from "@derive/core"
import type { VectorStore } from "@derive/db/pgvector"
import { EMBED_BATCH } from "./embedder"
import { type ChunkUnit, rollupBestChunk, staleIds, unitsFor } from "./search-chunk"

// The dense-search adapter (used by BOTH tiers — edge and Postgres self-host): chunk-level semantic
// search backed by pgvector in the SAME Postgres as the artifacts. Same SearchIndex port, same
// chunking + best-chunk rollup (shared via search-chunk), same visibility contract (none: the
// caller's Tier-2 gate owns it). It composes an Embedder (the
// generation half) with a PgVectorStore (the storage half); the two must agree on dimensions, which
// PgVectorStore.ensureSchema enforces against the table. The caller runs this best-effort after the
// lexical index (its own try/catch in lib/search.ts) — NOT in the metadata transaction — but a
// committed vector is queryable on the next request (pgvector indexes synchronously), so there's no
// async-indexing propagation lag like Vectorize and no separate datastore to keep in sync.

// Over-fetch this many chunk hits, then roll up to the best chunk per artifact. Several top chunks
// can belong to one doc, so this yields fewer DISTINCT artifacts than raw hits — fine: the dense
// arm fuses with lexical (which dominates recall on the wide agent path) and precision is the win.
// The vector pool sets hnsw.ef_search ≥ this so pgvector's ANN scan doesn't cap the fetch below it
// (see node.ts / apply-pg-schema.ts).
const SEARCH_TOPK = 50

export class PgvectorSearchIndex implements SearchIndex {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
  ) {}

  // Embed + upsert a flat unit list in EMBED_BATCH groups, interleaved (not embed-all-then-write) —
  // bounds peak memory to one batch of vectors and lands earlier groups before a later embed can
  // fail. A count mismatch throws rather than misaligning vector↔chunk (the embedder returns one
  // vector per input, in order).
  private async embedAndStore(units: ChunkUnit[]): Promise<void> {
    for (let i = 0; i < units.length; i += EMBED_BATCH) {
      const group = units.slice(i, i + EMBED_BATCH)
      const vectors = await this.embedder.embed(group.map((u) => u.embedText))
      if (vectors.length !== group.length)
        throw new Error(`embedder returned ${vectors.length} vectors for ${group.length} chunks`)
      await this.store.upsert(
        group.map((u, j) => ({
          vectorId: u.vectorId,
          artifactId: u.artifactId,
          orgId: u.orgId,
          chunk: u.chunk,
          embedding: vectors[j] as number[],
          snippet: u.snippet,
        })),
      )
    }
  }

  async indexArtifact(
    id: string,
    orgId: string,
    title: string | null,
    text: string,
  ): Promise<void> {
    const units = unitsFor(id, orgId, title, text)
    // Upsert the fresh chunks first, then clear any chunk slots beyond the new count (a shrunk doc)
    // plus the bare legacy id. Empty content ⇒ no units ⇒ this clears everything for the artifact.
    // (upsert-then-delete, two statements: a delete failure leaves orphan chunks that self-heal on
    // the next index — best-effort, per the port's contract.)
    if (units.length) await this.embedAndStore(units)
    await this.store.deleteByIds(staleIds(id, units.length))
  }

  async indexArtifacts(
    items: { id: string; orgId: string; title: string | null; text: string }[],
  ): Promise<void> {
    const all: ChunkUnit[] = []
    const stale: string[] = []
    for (const it of items) {
      const units = unitsFor(it.id, it.orgId, it.title, it.text)
      all.push(...units)
      stale.push(...staleIds(it.id, units.length))
    }
    if (all.length) await this.embedAndStore(all)
    await this.store.deleteByIds(stale)
  }

  async unindexArtifact(id: string): Promise<void> {
    // Drop every chunk vector for the artifact in one statement (by artifact_id column).
    await this.store.deleteByArtifact(id)
  }

  async search(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]> {
    const q = query.trim()
    if (!q) return []
    const [vector] = await this.embedder.embed([q])
    if (!vector) return []
    const matches = await this.store.query(orgId, vector, SEARCH_TOPK)
    return rollupBestChunk(matches, limit, this.embedder.minScore)
  }

  async searchMany(
    orgId: string,
    queries: string[],
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[][]> {
    const out = queries.map(() => [] as { id: string; score: number; chunk: string }[])
    const nonempty = queries
      .map((query, index) => ({ query: query.trim(), index }))
      .filter(({ query }) => query.length > 0)
    if (!nonempty.length) return out
    const vectors = await this.embedder.embed(nonempty.map(({ query }) => query))
    if (vectors.length !== nonempty.length)
      throw new Error(`embedder returned ${vectors.length} vectors for ${nonempty.length} queries`)
    const matches = this.store.queryMany
      ? await this.store.queryMany(orgId, vectors, SEARCH_TOPK)
      : await Promise.all(vectors.map((vector) => this.store.query(orgId, vector, SEARCH_TOPK)))
    for (const [i, item] of nonempty.entries())
      out[item.index] = rollupBestChunk(matches[i] ?? [], limit, this.embedder.minScore)
    return out
  }

  // Nearest OTHER artifacts to one already-indexed artifact — same rollup, floor, and
  // no-visibility contract as `search`, but the query vector is the artifact's stored
  // LEAD chunk (chunk 0 = title + opening, the closest thing to a whole-doc summary
  // vector), so no embed call happens at query time. The bare legacy id covers a
  // pre-chunking vector that hasn't been re-indexed yet. Empty when the artifact has
  // no vector (never indexed, or the dense arm was down at publish) — callers treat
  // that as "no opinion", not an error.
  async similar(
    orgId: string,
    artifactId: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]> {
    const vector =
      (await this.store.getVector(`${artifactId}#0`)) ?? (await this.store.getVector(artifactId))
    if (!vector) return []
    const matches = await this.store.query(orgId, vector, SEARCH_TOPK)
    return rollupBestChunk(
      matches.filter((m) => m.artifactId !== artifactId),
      limit,
      this.embedder.minScore,
    )
  }
}
