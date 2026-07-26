import type { Embedder } from "@derive/core"

// A local, in-process ONNX embedder (Transformers.js) — the zero-Cloudflare self-host default:
// no account, no API token, no network at query time. bge-small-en-v1.5 (384-dim) is small
// (~30 MB int8) and fast on CPU. NODE-ONLY: this pulls onnxruntime-node (a native module) and
// must NEVER be imported by the Worker entry — node.ts is the only importer, and it loads the
// heavy runtime lazily via `loadLocalEmbedder` (dynamic import) so it's paid for only when the
// local provider is actually selected.

export const LOCAL_MODEL = "Xenova/bge-small-en-v1.5"
export const LOCAL_DIMENSIONS = 384
// Relevance floor for bge-small (CLS-pooled, q8). ESTIMATE from a small probe: relevant queries
// ~0.61–0.66, clear off-target ~0.49, so 0.50 trims the obvious noise while keeping relevant hits.
// bge-small's cosine geometry differs from bge-m3's (it runs higher + narrower), so this is
// deliberately its OWN value (rides Embedder.minScore). Worth re-measuring on a real corpus.
export const LOCAL_MIN_SCORE = 0.5
// Texts per forward pass — bounds peak memory/latency of CPU inference on a large index page.
const LOCAL_BATCH = 32

/** The slice of a Transformers.js feature-extraction pipeline we use. Structurally typed so this
 *  file needs no heavy runtime type, and tests can inject a fake extractor. */
export type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "cls"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

// bge-small is a CLS-pooling model (its sentence-transformers config uses the [CLS] token, not mean
// pooling — using mean would give off-spec embeddings), and normalize:true makes the vectors unit-
// length so pgvector's cosine distance is a true cosine similarity.
export class LocalEmbedder implements Embedder {
  readonly model = LOCAL_MODEL
  readonly dimensions = LOCAL_DIMENSIONS
  readonly minScore = LOCAL_MIN_SCORE
  constructor(private readonly extractor: FeatureExtractor) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += LOCAL_BATCH) {
      const slice = texts.slice(i, i + LOCAL_BATCH)
      const tensor = await this.extractor(slice, { pooling: "cls", normalize: true })
      const vectors = tensor.tolist()
      if (vectors.length !== slice.length)
        throw new Error(
          `local embedder returned ${vectors.length} vectors for ${slice.length} inputs`,
        )
      out.push(...vectors)
    }
    return out
  }
}

// Load the real Transformers.js pipeline once (downloads the model on first run, then cached to
// disk) and wrap it. Called at boot so the model is warm before the first search. The dynamic
// import keeps onnxruntime-node out of any eager graph (and out of the Worker bundle entirely).
// `dtype: "q8"` picks the int8-quantized weights (~30 MB, faster CPU inference) — without it Node
// defaults to fp32 (~120 MB, slower), since the library only auto-quantizes on the wasm device.
export const loadLocalEmbedder = async (): Promise<LocalEmbedder> => {
  const { pipeline } = await import("@huggingface/transformers")
  const extractor = await pipeline("feature-extraction", LOCAL_MODEL, { dtype: "q8" })
  return new LocalEmbedder(extractor as unknown as FeatureExtractor)
}
