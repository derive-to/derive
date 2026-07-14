import type { SearchIndex } from "@derive/core"

// The Cloudflare-edge adapter for the SearchIndex port: dense/semantic workspace search over
// Vectorize, embeddings from Workers AI. Model is bge-m3 (1024-dim — under Vectorize's 1536 cap —
// 8K-token, 100+ languages, which also lifts the CJK weakness of the lexical FTS). ONE vector per
// artifact (whole-doc embed) in this first cut: re-index is an upsert by artifact id and unindex a
// single delete, so lifecycle stays trivial; chunk-level embedding (finer recall on long docs) is a
// later enhancement. `org_id` is a pre-declared Vectorize metadata index so a query filters to one
// workspace — per-viewer visibility stays in the caller's Tier-2 gate, so this adapter, like the
// FTS, never widens what a viewer sees. Structural binding interfaces (rather than
// @cloudflare/workers-types) keep it unit-testable with a fake and robust to type-package churn;
// the real `env.VECTORIZE` / `env.AI` bindings satisfy them structurally.

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
// A payload guard on the text handed to the model, NOT the real token bound. bge-m3 accepts 8192
// tokens and we pass `truncate_inputs: true`, so the MODEL trims anything longer to its first 8192
// tokens — the tail drops (the lexical arm and the one-artifact grep still reach a past-the-bound
// hit, same shape as the FTS MAX_INDEX_TEXT bound). This char cap just avoids shipping a multi-MB
// body: ~24k chars is roughly a whole Latin doc (~6k tokens); for dense scripts (≈1 token/char) the
// model's token truncation is what bounds it. WITHOUT truncate_inputs an over-limit input is a
// BadInput error, not a silent trim — which would drop long (esp. CJK) docs from the dense index.
export const EMBED_CHAR_BUDGET = 24_000
// The stored semantic snippet (Vectorize metadata caps at 10 KiB/vector; this stays far under it).
export const PREVIEW_CHARS = 480

export class VectorizeSearchIndex implements SearchIndex {
  constructor(
    private readonly vectorize: VectorizeLike,
    private readonly ai: WorkersAiLike,
    private readonly model: string = EMBED_MODEL,
  ) {}

  private async embed(text: string): Promise<number[]> {
    // truncate_inputs:true so an over-8192-token body (long or CJK docs, where ~1 char ≈ 1 token)
    // trims to the limit instead of throwing BadInput — otherwise those docs silently never embed.
    const { data } = await this.ai.run(this.model, { text: [text], truncate_inputs: true })
    const vector = data[0]
    if (!vector) throw new Error("empty embedding from Workers AI")
    return vector
  }

  async indexArtifact(
    id: string,
    orgId: string,
    title: string | null,
    text: string,
  ): Promise<void> {
    const content = title ? `${title}\n\n${text}` : text
    // Nothing embeddable (e.g. a bare uploaded image) — ensure a prior vector doesn't linger.
    if (!content.trim()) return this.unindexArtifact(id)
    const values = await this.embed(content.slice(0, EMBED_CHAR_BUDGET))
    await this.vectorize.upsert([
      { id, values, metadata: { org_id: orgId, preview: content.slice(0, PREVIEW_CHARS) } },
    ])
  }

  async unindexArtifact(id: string): Promise<void> {
    await this.vectorize.deleteByIds([id])
  }

  async search(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]> {
    const q = query.trim()
    if (!q) return []
    const vector = await this.embed(q)
    // topK is capped at 50 (Vectorize's ceiling when metadata is returned). The `org_id` filter
    // needs a pre-declared metadata index (see wrangler.toml / DEPLOY.md); `preview` is unindexed
    // metadata, so "all" is required to read it back for the snippet.
    const { matches } = await this.vectorize.query(vector, {
      topK: Math.min(Math.max(limit, 1), 50),
      filter: { org_id: orgId },
      returnMetadata: "all",
    })
    return matches.map((m) => ({
      id: m.id,
      score: m.score,
      chunk: typeof m.metadata?.preview === "string" ? m.metadata.preview : "",
    }))
  }
}
