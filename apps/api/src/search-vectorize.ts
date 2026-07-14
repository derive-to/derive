import type { SearchIndex } from "@derive/core"

// The Cloudflare-edge adapter for the SearchIndex port: dense/semantic workspace search over
// Vectorize, embeddings from Workers AI. Model is bge-m3 (1024-dim — under Vectorize's 1536 cap —
// 8K-token, 100+ languages, which also lifts the CJK weakness of the lexical FTS). CHUNK-LEVEL: each
// artifact is split into ~450-token passages, one vector per chunk (id `${artifactId}#i`), so a
// query matching a specific passage scores against THAT passage instead of the whole-doc average —
// sharper relevance, and the stored snippet is drawn from the matching chunk (its head, not
// necessarily the exact matched sentence). `search` rolls chunk hits up to the best chunk per
// artifact. Chunking multiplies the vector count ~5–20×, which scales Vectorize's stored- AND
// queried-dimension billing the same (query cost bills on stored-vector count, not topK): a ~240-doc
// corpus goes from ~240 to ≤~4.8k vectors, enough to exhaust the free queried-dim tier in a handful
// of searches/month — the deliberate cost of the precision win. `org_id` is a pre-declared metadata
// index so a query filters to one workspace — per-viewer visibility stays in the caller's Tier-2
// gate, so this adapter, like the FTS, never widens what a viewer sees. Structural binding
// interfaces (rather than @cloudflare/workers-types) keep it unit-testable with a fake and robust to
// type-package churn; the real `env.VECTORIZE` / `env.AI` bindings satisfy them structurally.

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

/** The slice of a Workers AI binding this adapter uses (text embeddings). `truncate_inputs`
 *  makes the model trim an over-long input to its token limit instead of erroring (see embed). */
export interface WorkersAiLike {
  run(
    model: string,
    inputs: { text: string[]; truncate_inputs?: boolean },
  ): Promise<{ data: number[][] }>
}

export const EMBED_MODEL = "@cf/baai/bge-m3"
// Target chunk size in chars (~450 bge-m3 tokens at ~4 chars/token for Latin text) with ~15% overlap
// so a match spanning a boundary still lands wholly in a chunk. truncate_inputs:true guarantees a
// chunk never exceeds the model's 8192-token limit even for dense scripts (~1 token/char).
export const CHUNK_CHARS = 1800
export const CHUNK_OVERLAP = 270
// Bound the vectors per artifact: a fixed max makes the delete deterministic (drop `id#0..MAX-1`)
// with no need to track the prior chunk count, and caps index growth. 20 chunks span ≈31k unique
// chars (~1800 + 19×1530 after overlap) ≈ 7–8k tokens, covering a whole normal doc; a longer doc's
// tail isn't chunk-indexed (the lexical arm + the one-artifact grep still reach it — same shape as
// the FTS MAX_INDEX_TEXT bound). At ≤20 vectors/doc this is the ~5–20× vector-count (and thus
// per-search query-billing) multiplier over whole-doc indexing noted in the header — deliberate.
export const MAX_CHUNKS = 20
// Cap on the text handed to the chunker (data: URIs are already elided upstream). CHUNK_CHARS×MAX.
export const EMBED_CHAR_BUDGET = CHUNK_CHARS * MAX_CHUNKS
// The stored per-chunk snippet (Vectorize metadata caps at 10 KiB/vector; a chunk stays well under).
export const PREVIEW_CHARS = 480
// Minimum cosine similarity for a dense candidate to count as relevant. Calibrated on the live index
// (3 real + 3 gibberish queries): whole-doc real-query tops sat ~0.53–0.60, off-target ~0.44–0.54,
// so 0.48 removed the lowest noise slice with no observed recall loss. CHUNK vectors score SHARPER
// (a query hits the matching passage, not a doc average), so the same floor is EXPECTED to behave at
// least as well on chunks — but that's an untested inference, so re-measure on the live chunk index
// before trusting it. Tunable; exported so it can be referenced in tests.
export const DENSE_MIN_SCORE = 0.48
// Embed at most this many texts per Workers-AI call — bge-m3's sync-embed batch ceiling is 100, so
// 50 is conservative. Exported for the sub-batch test.
export const EMBED_BATCH = 50
// Vectorize documents a 1000-item/call upsert cap; we bound deletes the same way (mutations share
// that batch limit) so chunk deletes stay safely under it.
const MUTATE_BATCH = 500

// Split `text` into overlapping ~CHUNK_CHARS chunks, breaking at a whitespace boundary near the end
// (to avoid mid-word cuts), capped at MAX_CHUNKS. Pure — unit-tested. The `minBreak` guard also
// guarantees forward progress (each chunk advances by ≥ 0.6·CHUNK_CHARS − OVERLAP > 0).
export const chunkText = (text: string): string[] => {
  const t = text.trimEnd()
  if (!t.trim()) return []
  if (t.length <= CHUNK_CHARS) return [t.trim()]
  const chunks: string[] = []
  const minBreak = Math.floor(CHUNK_CHARS * 0.6)
  let start = 0
  while (start < t.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + CHUNK_CHARS, t.length)
    if (end < t.length) {
      const window = t.slice(start, end)
      const nl = window.lastIndexOf("\n")
      const sp = window.lastIndexOf(" ")
      const brk = nl >= minBreak ? nl : sp >= minBreak ? sp : -1
      if (brk > 0) end = start + brk
    }
    const chunk = t.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= t.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks
}

// One embed unit = one chunk's vector-to-be: its target id, the text to embed (title prepended for
// cheap contextual retrieval), the snippet to store, and the artifact it rolls up to.
interface Unit {
  vectorId: string
  orgId: string
  artifactId: string
  embedText: string
  snippet: string
}

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

  // The chunk units an artifact contributes (no embedding). A title-only artifact still indexes its
  // title as a single unit so title-only docs stay findable.
  private unitsFor(id: string, orgId: string, title: string | null, text: string): Unit[] {
    const body = chunkText(text.slice(0, EMBED_CHAR_BUDGET))
    const chunks = body.length ? body : title?.trim() ? [""] : []
    return chunks.map((c, i) => ({
      vectorId: `${id}#${i}`,
      orgId,
      artifactId: id,
      embedText: [title, c].filter(Boolean).join("\n\n"),
      snippet: (c || title || "").slice(0, PREVIEW_CHARS),
    }))
  }

  // Every vector id an artifact could hold from chunk `count` onward, plus the bare legacy id (a
  // whole-doc vector from before chunking). Deleting these is the deterministic "clear the stale
  // remainder": no prior-count tracking, and it migrates a legacy vector on the artifact's next index.
  private staleIds(id: string, keptChunks: number): string[] {
    const ids = [id]
    for (let i = keptChunks; i < MAX_CHUNKS; i++) ids.push(`${id}#${i}`)
    return ids
  }

  // Embed a flat unit list in EMBED_BATCH groups and upsert per group — bounded failure + no
  // cross-group misalignment; a short/misordered model response throws loudly, not silent
  // cross-contamination (bge-m3 returns one vector per input in order).
  private async embedAndUpsert(units: Unit[]): Promise<void> {
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
    const units = this.unitsFor(id, orgId, title, text)
    // Upsert the fresh chunks first (no empty window), then clear the legacy vector + any chunk
    // slots beyond the new count (a shrunk doc). Empty content ⇒ no units ⇒ this clears everything.
    await this.embedAndUpsert(units)
    await this.vectorize.deleteByIds(this.staleIds(id, units.length))
  }

  async indexArtifacts(
    items: { id: string; orgId: string; title: string | null; text: string }[],
  ): Promise<void> {
    const all: Unit[] = []
    const stale: string[] = []
    for (const it of items) {
      const units = this.unitsFor(it.id, it.orgId, it.title, it.text)
      all.push(...units)
      stale.push(...this.staleIds(it.id, units.length))
    }
    // Chunks from all artifacts embed together in EMBED_BATCH groups (far fewer AI calls than
    // per-artifact); stale ids clear after the fresh chunks land.
    await this.embedAndUpsert(all)
    await this.deleteInBatches(stale)
  }

  async unindexArtifact(id: string): Promise<void> {
    // Drop every possible vector for the artifact: all chunk slots + the bare legacy id.
    await this.vectorize.deleteByIds(this.staleIds(id, 0))
  }

  async search(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]> {
    const q = query.trim()
    if (!q) return []
    const vector = await this.embed(q)
    // topK 50 (Vectorize's ceiling with metadata, raised from 20 in 2026-03). Over-fetch chunk hits,
    // then roll up to the best chunk per artifact — several top chunks can belong to one doc, so 50
    // chunks yields FEWER distinct artifacts than the old 50-whole-doc-vectors did. On the small
    // typeahead limit that's invisible; on the agent/deep path (large candidateCap) it narrows the
    // dense arm's breadth — an accepted trade, since that arm fuses with the lexical one (which
    // dominates recall there) and precision is the win. Worth re-measuring distinct-artifact recall
    // on the live chunk index post-deploy. The `org_id` filter needs a pre-declared metadata index;
    // `artifact_id`/`chunk` are unindexed, so "all" is required to read them back for rollup + snippet.
    const { matches } = await this.vectorize.query(vector, {
      topK: 50,
      filter: { org_id: orgId },
      returnMetadata: "all",
    })
    // Best chunk per artifact, above the relevance floor. Robust to legacy whole-doc vectors from
    // before chunking (no `artifact_id` → fall back to the id before `#`; `chunk` → `preview`).
    const best = new Map<string, { score: number; chunk: string }>()
    for (const m of matches) {
      if (m.score < DENSE_MIN_SCORE) continue
      const md = m.metadata ?? {}
      const artId =
        typeof md.artifact_id === "string" ? md.artifact_id : (m.id.split("#")[0] ?? m.id)
      const chunk =
        typeof md.chunk === "string" ? md.chunk : typeof md.preview === "string" ? md.preview : ""
      const prev = best.get(artId)
      if (!prev || m.score > prev.score) best.set(artId, { score: m.score, chunk })
    }
    return [...best.entries()]
      .map(([id, v]) => ({ id, score: v.score, chunk: v.chunk }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit, 1))
  }
}
