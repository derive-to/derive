import type { SessionMessageRecord } from "@derive/core"
import type { AgentLoopInput } from "./agent-loop"

/**
 * HOW LONG THE MODEL TOOK, measured where a turn already happens and recorded where a turn is
 * already recorded.
 *
 * An operator swapping models needs to know whether the new one is faster, and the honest answer
 * comes from real traffic rather than from a synthetic probe: a probe says what one small call
 * costs on an idle path, while this says what people are actually waiting for. A probe is still
 * worth having — it is the only thing that can answer for a model NOBODY has used yet, which is
 * every model the moment it is added — so the two are complements and neither replaces the other.
 *
 * NO NEW WRITE PATH, WHICH IS THE ENTIRE REASON THIS IS CHEAP. The agent's answer already
 * persists `model` and `cost_micro_usd` in `session_message.meta`; this adds two more numbers to
 * the same object on the same insert. Nothing is written per model call, no counter is
 * incremented, and no row exists that would not have existed anyway.
 *
 * MODEL TIME, NOT TURN TIME. A turn runs the model several times with tool calls in between, and
 * a tool that spends four seconds calling somebody's API is not the model being slow. Only the
 * time inside `callModel` is counted, so the number compares models rather than workloads.
 */

/** What one turn spent on the model. */
export interface TurnTiming {
  /** Each call's own duration, in order. Not just the sum: three calls of 1.5s and one of 4.5s
   *  are the same total and completely different problems — the first is per-call latency to
   *  fix, the second is one pathological step to find. */
  each: number[]
  /** Time to the FIRST token of the FIRST model call, ms — what the person actually waited
   *  through before anything appeared. Null when nothing streamed. */
  ttftMs: number | null
  /** Summed wall time inside `callModel` across the turn, ms. Excludes tool execution. */
  modelMs: number
  /** How many model calls the turn made. Without it a big `modelMs` is unreadable: a slow model
   *  and a model that was asked eight times look identical. */
  calls: number
}

/** Wrap a turn's `callModel` so it reports what it spent. The returned `call` is a drop-in for
 *  the one passed in — an adapter that never streams simply leaves `ttftMs` null, exactly as the
 *  callModel contract allows. */
export const meterModel = (
  callModel: AgentLoopInput["callModel"],
  now: () => number = () => Date.now(),
): { call: AgentLoopInput["callModel"]; timing: () => TurnTiming } => {
  let ttftMs: number | null = null
  let modelMs = 0
  let calls = 0
  const each: number[] = []
  const call: AgentLoopInput["callModel"] = async (input) => {
    const started = now()
    calls += 1
    try {
      return await callModel({
        ...input,
        onDelta: (text) => {
          // FIRST call only: a later turn's first token arrives after tools have run, so
          // recording it would report tool latency as the model's.
          if (ttftMs === null && calls === 1) ttftMs = now() - started
          input.onDelta?.(text)
        },
      })
    } finally {
      // In `finally`, so a turn that threw still reports what it burned. A failing provider that
      // takes 30s to fail is the single most useful measurement on this page, and it is exactly
      // the one a success-only meter would drop.
      const took = now() - started
      modelMs += took
      each.push(took)
    }
  }
  return { call, timing: () => ({ ttftMs, modelMs, calls, each: [...each] }) }
}

/** The timing fields as they are stored on an answer's meta — snake_case, alongside `model` and
 *  `cost_micro_usd`, because that is the register everything else in that blob is written in. */
export const timingMeta = (t: TurnTiming): Record<string, number | null> => ({
  ttft_ms: t.ttftMs,
  model_ms: t.modelMs,
  model_calls: t.calls,
})

/** One model's observed performance over the sample. */
export interface ModelTimings {
  modelId: string
  /** Answers in the sample that named this model AND carried a timing. */
  samples: number
  /** Median and p95 of time-to-first-token, ms. Null when nothing in the sample streamed. */
  ttftP50: number | null
  ttftP95: number | null
  /** Median and p95 of model time per turn, ms. */
  totalP50: number | null
  totalP95: number | null
  /** The newest answer this model produced in the sample (ISO), so an operator can tell a model
   *  that is fast from one that has not run since yesterday. */
  lastAt: string | null
}

/**
 * Fold recent answers into per-model timings.
 *
 * MEDIAN AND p95, NOT MEAN. One 60-second timeout drags a mean far enough to condemn a model that
 * is fine, and the tail is the thing an operator is actually deciding about — so the number that
 * moves must be the one that means something. p95 on a handful of samples is a coarse instrument;
 * `samples` travels with it so a reader can discount it, rather than the code hiding a number it
 * has decided is not good enough yet.
 *
 * Messages with no timing are skipped rather than counted as zero: every answer written before
 * this shipped has none, and treating those as instant would report every model as faster than it
 * is for as long as the sample window reaches back.
 */
export const foldTimings = (
  messages: Pick<SessionMessageRecord, "meta" | "created_at">[],
): ModelTimings[] => {
  const by = new Map<string, { ttft: number[]; total: number[]; lastAt: string | null }>()
  for (const m of messages) {
    const meta = parseMeta(m.meta)
    if (!meta) continue
    const modelId = typeof meta.model?.id === "string" ? meta.model.id : null
    if (!modelId) continue
    const total = num(meta.model_ms)
    const ttft = num(meta.ttft_ms)
    if (total === null && ttft === null) continue
    let bucket = by.get(modelId)
    if (!bucket) {
      bucket = { ttft: [], total: [], lastAt: null }
      by.set(modelId, bucket)
    }
    if (ttft !== null) bucket.ttft.push(ttft)
    if (total !== null) bucket.total.push(total)
    // Newest-first input, so the first sighting is the latest — but compared rather than assumed,
    // because a caller passing an arbitrary list must not get a silently wrong "last seen".
    if (!bucket.lastAt || m.created_at > bucket.lastAt) bucket.lastAt = m.created_at
  }
  return [...by.entries()]
    .map(([modelId, b]) => ({
      modelId,
      samples: Math.max(b.total.length, b.ttft.length),
      ttftP50: percentile(b.ttft, 50),
      ttftP95: percentile(b.ttft, 95),
      totalP50: percentile(b.total, 50),
      totalP95: percentile(b.total, 95),
      lastAt: b.lastAt,
    }))
    .sort((a, b) => b.samples - a.samples)
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null

interface AnswerMeta {
  model?: { id?: unknown }
  model_ms?: unknown
  ttft_ms?: unknown
}

/** A hand-edited or truncated blob costs its own message, never the whole page. */
const parseMeta = (raw: string | null): AnswerMeta | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === "object" ? (v as AnswerMeta) : null
  } catch {
    return null
  }
}

/** Nearest-rank percentile. Exact on the sample rather than interpolated: these are milliseconds
 *  from real turns, and a value that actually happened is easier to reason about than one
 *  between two that did. */
const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null
}
