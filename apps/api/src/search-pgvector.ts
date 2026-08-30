import type { Embedder, SearchIndex } from "@derive/core"
import type { VectorStore } from "@derive/db/pgvector"
import { EMBED_BATCH } from "./embedder"
import { WeightedLruCache, type WeightedLruCacheOptions } from "./lib/source-text-cache"
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
const INDEXED_PROJECTION_CACHE_BYTES = 8 * 1024 * 1024
const INDEXED_PROJECTION_CACHE_ENTRIES = 128
const INDEXED_PROJECTION_CACHE_ENTRY_BYTES = 512 * 1024
const INDEXED_PROJECTION_CACHE_IDLE_MS = 10 * 60 * 1000

const sameUnits = (a: ChunkUnit[], b: ChunkUnit[]): boolean =>
  a.length === b.length &&
  a.every((unit, i) => {
    const other = b[i]
    return (
      other !== undefined &&
      unit.vectorId === other.vectorId &&
      unit.chunk === other.chunk &&
      unit.orgId === other.orgId &&
      unit.artifactId === other.artifactId &&
      unit.embedText === other.embedText &&
      unit.snippet === other.snippet
    )
  })

// Approximate the JS string storage, plus a small fixed amount for the unit fields.
// The cache is an optimization only, so conservative over-counting is preferable.
const unitsWeight = (units: ChunkUnit[]): number =>
  units.reduce((bytes, unit) => bytes + (unit.embedText.length + unit.snippet.length) * 2 + 96, 0)

/**
 * A small L0 receipt cache for dense projections that fully reached pgvector.
 *
 * Workers build a request-scoped PgVectorStore around the live Hyperdrive pool, so
 * worker.ts supplies one module-scoped cache to successive adapter instances. Node
 * creates one long-lived adapter and uses the constructor default. The key includes
 * the embedding model and dimensions, so a model switch never reuses a receipt from
 * another vector space.
 */
export class IndexedProjectionCache {
  private readonly cache: WeightedLruCache<ChunkUnit[]>

  constructor(options: WeightedLruCacheOptions = {}) {
    this.cache = new WeightedLruCache({
      maxBytes: INDEXED_PROJECTION_CACHE_BYTES,
      maxEntries: INDEXED_PROJECTION_CACHE_ENTRIES,
      maxEntryBytes: INDEXED_PROJECTION_CACHE_ENTRY_BYTES,
      idleTtlMs: INDEXED_PROJECTION_CACHE_IDLE_MS,
      ...options,
    })
  }

  get(key: string): ChunkUnit[] | undefined {
    return this.cache.get(key)
  }

  set(key: string, units: ChunkUnit[]): void {
    this.cache.set(key, units, unitsWeight(units))
  }

  delete(key: string): void {
    this.cache.delete(key)
  }
}

export class PgvectorSearchIndex implements SearchIndex {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly indexedProjections = new IndexedProjectionCache(),
  ) {}

  private projectionKey(id: string): string {
    return `${this.embedder.model}:${this.embedder.dimensions}:${id}`
  }

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
    const cacheKey = this.projectionKey(id)
    const indexed = this.indexedProjections.get(cacheKey)
    // This is deliberately a success cache, not an assumption derived from source
    // equality. An entry is written only after BOTH vector upserts and stale cleanup
    // complete. A cold process, an evicted entry, or a failed prior update takes the
    // full recovery path and re-indexes exactly as before.
    if (indexed && sameUnits(indexed, units)) return
    // Upsert the fresh chunks first, then clear any chunk slots beyond the new count (a shrunk doc)
    // plus the bare legacy id. Empty content ⇒ no units ⇒ this clears everything for the artifact.
    // (upsert-then-delete, two statements: a delete failure leaves orphan chunks that self-heal on
    // the next index — best-effort, per the port's contract.)
    if (units.length) await this.embedAndStore(units)
    await this.store.deleteByIds(staleIds(id, units.length))
    this.indexedProjections.set(cacheKey, units)
  }

  async indexArtifacts(
    items: { id: string; orgId: string; title: string | null; text: string }[],
  ): Promise<void> {
    const all: ChunkUnit[] = []
    const stale: string[] = []
    const indexed: { id: string; units: ChunkUnit[] }[] = []
    for (const it of items) {
      const units = unitsFor(it.id, it.orgId, it.title, it.text)
      const cacheKey = this.projectionKey(it.id)
      const cached = this.indexedProjections.get(cacheKey)
      if (cached && sameUnits(cached, units)) continue
      all.push(...units)
      stale.push(...staleIds(it.id, units.length))
      indexed.push({ id: cacheKey, units })
    }
    if (all.length) await this.embedAndStore(all)
    await this.store.deleteByIds(stale)
    for (const item of indexed) this.indexedProjections.set(item.id, item.units)
  }

  async unindexArtifact(id: string): Promise<void> {
    // Drop every chunk vector for the artifact in one statement (by artifact_id column).
    await this.store.deleteByArtifact(id)
    this.indexedProjections.delete(this.projectionKey(id))
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
