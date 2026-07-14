// Backend-agnostic chunk-level dense-search logic, shared by every SearchIndex adapter (the
// Cloudflare Vectorize edge adapter and the pgvector self-host adapter). Keeping the chunker,
// the per-chunk unit shape, the stale-id math, and the best-chunk rollup in ONE place is what
// stops the edge and self-host corpora from silently diverging — a change to chunk size or the
// relevance floor lands in both at once. Pure + unit-tested; no store or embedder dependency.

// Target chunk size in chars (~450 bge-m3 tokens at ~4 chars/token for Latin text) with ~15%
// overlap so a match spanning a boundary still lands wholly in a chunk.
export const CHUNK_CHARS = 1800
export const CHUNK_OVERLAP = 270
// Bound the vectors per artifact: a fixed max makes the delete deterministic (drop `id#0..MAX-1`)
// with no need to track the prior chunk count, and caps index growth. 20 chunks span ≈31k unique
// chars (~1800 + 19×1530 after overlap) ≈ 7–8k tokens, covering a whole normal doc; a longer doc's
// tail isn't chunk-indexed (the lexical arm + the one-artifact grep still reach it).
export const MAX_CHUNKS = 20
// Cap on the text handed to the chunker (data: URIs are already elided upstream). CHUNK_CHARS×MAX.
export const EMBED_CHAR_BUDGET = CHUNK_CHARS * MAX_CHUNKS
// The stored per-chunk snippet (kept well under any store's per-row metadata cap).
export const PREVIEW_CHARS = 480
// Minimum cosine similarity for a dense candidate to count as relevant. Calibrated on the live
// bge-m3 chunk index (3 real + 3 gibberish queries): real-query tops ~0.59–0.62, off-target
// ~0.44–0.55, real 5th-best ~0.574, so 0.48 trims the clear noise tail with no observed recall
// loss. Model-specific — a different embedder (e.g. bge-small on self-host) needs its own
// measurement. Tunable; exported so it can be referenced in tests.
export const DENSE_MIN_SCORE = 0.48

// Split `text` into overlapping ~CHUNK_CHARS chunks, breaking at a whitespace boundary near the
// end (to avoid mid-word cuts), capped at MAX_CHUNKS. Pure — unit-tested. The `minBreak` guard also
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

// One embed unit = one chunk's vector-to-be: its target id (`${artifactId}#i`), the chunk index,
// the text to embed (title prepended for cheap contextual retrieval), the snippet to store, and
// the artifact it rolls up to.
export interface ChunkUnit {
  vectorId: string
  chunk: number
  orgId: string
  artifactId: string
  embedText: string
  snippet: string
}

// The chunk units an artifact contributes (no embedding). A title-only artifact still indexes its
// title as a single unit so title-only docs stay findable.
export const unitsFor = (
  id: string,
  orgId: string,
  title: string | null,
  text: string,
): ChunkUnit[] => {
  const body = chunkText(text.slice(0, EMBED_CHAR_BUDGET))
  const chunks = body.length ? body : title?.trim() ? [""] : []
  return chunks.map((c, i) => ({
    vectorId: `${id}#${i}`,
    chunk: i,
    orgId,
    artifactId: id,
    embedText: [title, c].filter(Boolean).join("\n\n"),
    snippet: (c || title || "").slice(0, PREVIEW_CHARS),
  }))
}

// Every vector id an artifact could hold from chunk `keptChunks` onward, plus the bare legacy id
// (a whole-doc vector from before chunking). Deleting these is the deterministic "clear the stale
// remainder": no prior-count tracking, and it migrates a legacy vector on the artifact's next index.
export const staleIds = (id: string, keptChunks: number): string[] => {
  const ids = [id]
  for (let i = keptChunks; i < MAX_CHUNKS; i++) ids.push(`${id}#${i}`)
  return ids
}

// Roll raw scored chunk matches up to the best (highest-score) chunk per artifact, dropping
// anything below the relevance floor, sorted by score desc and capped at `limit`. Every adapter
// normalizes its store's rows into this `{ artifactId, score, chunk }` shape first, so the fuse-
// facing result is identical regardless of backend.
export const rollupBestChunk = (
  matches: { artifactId: string; score: number; chunk: string }[],
  limit: number,
): { id: string; score: number; chunk: string }[] => {
  const best = new Map<string, { score: number; chunk: string }>()
  for (const m of matches) {
    if (m.score < DENSE_MIN_SCORE) continue
    const prev = best.get(m.artifactId)
    if (!prev || m.score > prev.score) best.set(m.artifactId, { score: m.score, chunk: m.chunk })
  }
  return [...best.entries()]
    .map(([id, v]) => ({ id, score: v.score, chunk: v.chunk }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit, 1))
}
