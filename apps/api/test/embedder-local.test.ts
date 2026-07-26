import { describe, expect, it } from "vitest"
import {
  type FeatureExtractor,
  LOCAL_DIMENSIONS,
  LOCAL_MIN_SCORE,
  LOCAL_MODEL,
  LocalEmbedder,
} from "../src/embedder-local"

// LocalEmbedder over a FAKE extractor — the composition logic (pooling opts, sub-batching, count
// guard) without downloading/running the real ONNX model. The real model is validated out of band
// (it's a network + native-inference dependency, not a CI unit test).
const makeExtractor = (dim = 4) => {
  const calls: string[][] = []
  const opts: { pooling: string; normalize: boolean }[] = []
  const extractor: FeatureExtractor = async (texts, o) => {
    calls.push(texts)
    opts.push(o)
    return {
      tolist: () => texts.map((_, i) => Array.from({ length: dim }, (_, d) => (i + d) / 10)),
    }
  }
  return { extractor, calls, opts }
}

describe("LocalEmbedder", () => {
  it("exposes the pinned model, dimension and floor", () => {
    const { extractor } = makeExtractor()
    const emb = new LocalEmbedder(extractor)
    expect(emb.model).toBe(LOCAL_MODEL)
    expect(emb.dimensions).toBe(LOCAL_DIMENSIONS)
    expect(emb.minScore).toBe(LOCAL_MIN_SCORE)
  })

  it("CLS-pools + normalizes (the opts bge needs for cosine) and returns one vector per input", async () => {
    const { extractor, calls, opts } = makeExtractor()
    const out = await new LocalEmbedder(extractor).embed(["a", "b", "c"])
    expect(out).toHaveLength(3)
    expect(out[0]).toHaveLength(4)
    expect(calls[0]).toEqual(["a", "b", "c"])
    expect(opts[0]).toEqual({ pooling: "cls", normalize: true })
  })

  it("sub-batches inputs larger than LOCAL_BATCH (bounds CPU-inference memory), preserving order", async () => {
    const { extractor, calls } = makeExtractor()
    const n = 70 // > LOCAL_BATCH (32) → 3 forward passes
    const texts = Array.from({ length: n }, (_, i) => `t${i}`)
    const out = await new LocalEmbedder(extractor).embed(texts)
    expect(out).toHaveLength(n)
    expect(calls.length).toBe(3) // ceil(70/32)
    expect(calls[0]).toHaveLength(32)
    expect(calls[2]).toEqual([`t64`, `t65`, `t66`, `t67`, `t68`, `t69`]) // last partial batch
  })

  it("empty input embeds nothing (no extractor call)", async () => {
    const { extractor, calls } = makeExtractor()
    expect(await new LocalEmbedder(extractor).embed([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("throws (not misaligns) if the extractor returns a wrong vector count", async () => {
    const bad: FeatureExtractor = async () => ({ tolist: () => [[0.1, 0.2, 0.3, 0.4]] }) // 1 for N
    await expect(new LocalEmbedder(bad).embed(["a", "b"])).rejects.toThrow(
      /returned 1 vectors for 2 inputs/,
    )
  })
})
