import type { SearchIndex } from "@derive/core"
import { EMBED_BATCH, EMBED_MODEL, type WorkersAiLike } from "./embedder"
import { rollupBestChunk, staleIds, unitsFor } from "./search-chunk"

// The Cloudflare-edge adapter for the SearchIndex port: dense/semantic workspace search over
// Vectorize, embeddings from Workers AI bge-m3 (1024-dim). CHUNK-LEVEL: each artifact is split into
// ~450-token passages (shared logic in search-chunk), one vector per chunk (id `${artifactId}#i`),
// so a query matching a specific passage scores against THAT passage instead of the whole-doc
// average — sharper relevance, and the stored snippet is drawn from the matching chunk (its head).
// `search` rolls chunk hits up to the best chunk per artifact. Chunking multiplies the vector count
// ~5–20×, which scales Vectorize's queried-dimension billing on stored-vector count (not topK) — the
// deliberate cost of the precision win. `org_id` is a pre-declared metadata index so a query filters
// to one workspace — per-viewer visibility stays in the caller's Tier-2 gate, so this adapter never
// widens what a viewer sees. Structural binding interfaces (rather than @cloudflare/workers-types)
// keep it unit-testable with a fake.
//
// This is the edge storage backend; the self-host counterpart is PgvectorSearchIndex (pgvector in
// the primary Postgres). Both share the chunker + rollup (search-chunk), so the corpora stay
// consistent.

export { EMBED_BATCH, EMBED_MODEL, type WorkersAiLike } from "./embedder"
// Re-exported so existing imports/tests keep resolving these from this module after the shared
// chunk logic was extracted into search-chunk / embedder.
export {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  chunkText,
  DENSE_MIN_SCORE,
  MAX_CHUNKS,
  PREVIEW_CHARS,
} from "./search-chunk"

/** The slice of a Vectorize binding this adapter uses. */
export interface VectorizeLike {
  upsert(
    vectors: { id: string; values: number[]; metadata?: Record<string, string> }[],
  ): Promise<unknown>
  query(
    vector: number[],
    opts: {
      topK?: number
      filter?: Record<string, unknown>
      returnMetadata?: "none" | "indexed" | "all"
    },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>
  deleteByIds(ids: string[]): Promise<unknown>
}

// Vectorize caps upsert at 1000 items/call; we bound deletes the same way (mutations share that
// batch limit) so chunk deletes stay safely under it.
const MUTATE_BATCH = 500

export class VectorizeSearchIndex implements SearchIndex {
  constructor(
    private readonly vectorize: VectorizeLike,
    private readonly ai: WorkersAiLike,
    private readonly model: string = EMBED_MODEL,
  ) {}

  private async embed(text: string): Promise<number[]> {
    const { data } = await this.ai.run(this.model, { text: [text], truncate_inputs: true })
    const [vector] = data
    if (!vector) throw new Error("empty embedding from Workers AI")
    return vector
  }

  // Embed a flat unit list in EMBED_BATCH groups and upsert per group — bounded failure + no
  // cross-group misalignment; a short/misordered model response throws loudly (bge-m3 returns one
  // vector per input in order).
  private async embedAndUpsert(units: ReturnType<typeof unitsFor>): Promise<void> {
    for (let i = 0; i < units.length; i += EMBED_BATCH) {
      const slice = units.slice(i, i + EMBED_BATCH)
      const { data } = await this.ai.run(this.model, {
        text: slice.map((u) => u.embedText),
        truncate_inputs: true,
      })
      if (data.length !== slice.length)
        throw new Error(`bge-m3 returned ${data.length} vectors for ${slice.length} inputs`)
      await this.vectorize.upsert(
        slice.map((u, j) => ({
          id: u.vectorId,
          values: data[j] as number[],
          metadata: { org_id: u.orgId, artifact_id: u.artifactId, chunk: u.snippet },
        })),
      )
    }
  }

  private async deleteInBatches(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += MUTATE_BATCH)
      await this.vectorize.deleteByIds(ids.slice(i, i + MUTATE_BATCH))
  }

  async indexArtifact(
    id: string,
    orgId: string,
    title: string | null,
    text: string,
  ): Promise<void> {
    const units = unitsFor(id, orgId, title, text)
    await this.embedAndUpsert(units)
    await this.vectorize.deleteByIds(staleIds(id, units.length))
  }

  async indexArtifacts(
    items: { id: string; orgId: string; title: string | null; text: string }[],
  ): Promise<void> {
    const all: ReturnType<typeof unitsFor> = []
    const stale: string[] = []
    for (const it of items) {
      const units = unitsFor(it.id, it.orgId, it.title, it.text)
      all.push(...units)
      stale.push(...staleIds(it.id, units.length))
    }
    await this.embedAndUpsert(all)
    await this.deleteInBatches(stale)
  }

  async unindexArtifact(id: string): Promise<void> {
    await this.vectorize.deleteByIds(staleIds(id, 0))
  }

  async search(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]> {
    const q = query.trim()
    if (!q) return []
    const vector = await this.embed(q)
    // topK 50 (Vectorize's ceiling with metadata, raised from 20 in 2026-03). Over-fetch chunk
    // hits; rollup reduces to the best chunk per artifact. The `org_id` filter needs a pre-declared
    // metadata index; `artifact_id`/`chunk` are unindexed, so "all" reads them back for rollup.
    const { matches } = await this.vectorize.query(vector, {
      topK: 50,
      filter: { org_id: orgId },
      returnMetadata: "all",
    })
    // Normalize to the shared rollup shape. Robust to legacy whole-doc vectors from before chunking
    // (no `artifact_id` → the id before `#`; `chunk` → `preview`).
    const normalized = matches.map((m) => {
      const md = m.metadata ?? {}
      const artifactId =
        typeof md.artifact_id === "string" ? md.artifact_id : (m.id.split("#")[0] ?? m.id)
      const chunk =
        typeof md.chunk === "string" ? md.chunk : typeof md.preview === "string" ? md.preview : ""
      return { artifactId, score: m.score, chunk }
    })
    return rollupBestChunk(normalized, limit)
  }
}
