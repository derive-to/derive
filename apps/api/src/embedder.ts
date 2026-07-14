import type { Embedder } from "@derive/core"

// Embedder implementations (the generation half of the dense arm). Workers AI bge-m3 is reachable
// two ways with an identical model + 1024-dim output, so the edge and a self-host box can share ONE
// vector space (a corpus embedded on either is queryable by the other): the `env.AI` BINDING on
// Cloudflare, or the REST endpoint from any Node process holding an account id + token. A future
// local-ONNX embedder implements the same `Embedder` port and drops in with no store/wiring change.

export const EMBED_MODEL = "@cf/baai/bge-m3"
export const EMBED_DIMENSIONS = 1024
// Embed at most this many texts per Workers-AI call — bge-m3's sync-embed batch ceiling is 100, so
// 50 is conservative. Exported for the sub-batch test.
export const EMBED_BATCH = 50

/** The slice of a Workers AI binding this uses (text embeddings). `truncate_inputs` makes the model
 *  trim an over-long input to its token limit instead of erroring — structurally typed (not
 *  @cloudflare/workers-types) so `env.AI` satisfies it and tests can fake it. */
export interface WorkersAiLike {
  run(
    model: string,
    inputs: { text: string[]; truncate_inputs?: boolean },
  ): Promise<{ data: number[][] }>
}

/** Embed ONE batch (already ≤ the backend ceiling), returning raw vectors in input order. */
type BatchRunner = (texts: string[]) => Promise<number[][]>

// Workers AI bge-m3, over any batch runner. Handles EMBED_BATCH grouping + the count assert once,
// so a short/misordered backend response throws loudly instead of silently misaligning vectors.
export class WorkersAiEmbedder implements Embedder {
  readonly model = EMBED_MODEL
  readonly dimensions = EMBED_DIMENSIONS
  constructor(private readonly runBatch: BatchRunner) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const slice = texts.slice(i, i + EMBED_BATCH)
      const data = await this.runBatch(slice)
      if (data.length !== slice.length)
        throw new Error(`bge-m3 returned ${data.length} vectors for ${slice.length} inputs`)
      out.push(...data)
    }
    return out
  }
}

/** Edge embedder: the Cloudflare `env.AI` binding (no network egress, no token). */
export const bindingEmbedder = (ai: WorkersAiLike): WorkersAiEmbedder =>
  new WorkersAiEmbedder(async (texts) => {
    const { data } = await ai.run(EMBED_MODEL, { text: texts, truncate_inputs: true })
    return data
  })

/** Self-host embedder: Workers AI over REST, for a Node box with an account id + API token. Same
 *  model/dimension as the binding, so it shares the edge's vector space. (A local-ONNX embedder is
 *  the eventual zero-Cloudflare default; this is the first, dependency-free Node embedder.) */
export const restEmbedder = (
  accountId: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
): WorkersAiEmbedder =>
  new WorkersAiEmbedder(async (texts) => {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBED_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ text: texts, truncate_inputs: true }),
      },
    )
    if (!res.ok) {
      // Include a slice of the body — a 403/400 from Workers AI carries the real cause
      // (bad token, model not enabled) that the status text alone hides.
      const body = await res.text().catch(() => "")
      throw new Error(
        `Workers AI REST embed failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      )
    }
    const json = (await res.json()) as { result?: { data?: number[][] } }
    const data = json.result?.data
    if (!data) throw new Error("Workers AI REST embed: missing result.data")
    return data
  })
