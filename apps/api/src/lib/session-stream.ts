import type { AgentLoopInput } from "./agent-loop"

/**
 * Streaming a reply to the person waiting for it, without paying a round trip per token.
 *
 * WHY COALESCE. Each publish is one Durable Object fetch on the hosted tier (the per-user
 * `u:<id>` channel is a DO-backed room — see realtime-do.ts). A model emits hundreds of
 * tokens per reply, so publishing each one would be hundreds of DO calls for a single answer:
 * the exact "many small round trips" shape the rest of this work exists to remove. Slices are
 * therefore accumulated and flushed on a size or age boundary, taking a typical reply to tens
 * of publishes instead of hundreds.
 *
 * WHY NO TIMER. The obvious flush-on-an-interval needs a timer that outlives the request, and
 * background work in a Worker is bounded by waitUntil — a pending timer is a lifecycle hazard
 * and a leak when the turn throws. Instead the age check runs when the NEXT delta arrives, and
 * `flush()` (always called before the turn settles) covers whatever is left. A model that goes
 * quiet mid-reply simply holds its tail until the next token or the settle, which is exactly
 * when the reader would have seen it anyway.
 *
 * DELTAS ARE NEVER THE RECORD. Nothing here is persisted; the transcript row written when the
 * turn settles is the answer. A dropped or coalesced delta costs the animation, never content.
 */

/** Flush when the buffer reaches this many characters. A paragraph-ish slice: large enough to
 *  keep publish counts low, small enough that the text still visibly streams. */
export const DELTA_FLUSH_CHARS = 200
/** ...or when the oldest buffered text is this old, so a slow model still shows progress. */
export const DELTA_FLUSH_MS = 80

export interface DeltaStream {
  /** Wrap `callModel` so its text deltas publish, coalesced.
   *
   *  Wrapping the CALL rather than threading an `onDelta` parameter through runSessionTurn →
   *  runTurn → agent-loop keeps every one of those layers untouched: they pass `callModel`
   *  along as they always have, and the streaming decision stays where the transport is known. */
  wrap(inner: AgentLoopInput["callModel"]): AgentLoopInput["callModel"]
  /** Publish anything still buffered. Call before settling the turn. */
  flush(): void
  /** Slices published so far — the sequence a client uses to order and spot gaps. */
  readonly seq: number
}

export interface DeltaStreamOpts {
  /** Publish one coalesced slice. Failures are swallowed by the caller of this. */
  publish: (slice: { seq: number; text: string }) => void
  /** Injectable clock, so tests do not sleep. */
  now?: () => number
  flushChars?: number
  flushMs?: number
}

export const makeDeltaStream = (opts: DeltaStreamOpts): DeltaStream => {
  const now = opts.now ?? (() => Date.now())
  const maxChars = opts.flushChars ?? DELTA_FLUSH_CHARS
  const maxMs = opts.flushMs ?? DELTA_FLUSH_MS
  let buffer = ""
  let oldestAt = 0
  let seq = 0

  const flush = () => {
    if (!buffer) return
    seq += 1
    const slice = { seq, text: buffer }
    buffer = ""
    oldestAt = 0
    try {
      opts.publish(slice)
    } catch {
      // A transport blip must not abort a turn the model has already been paid for. The
      // transcript still lands on settle, so the reader gets the whole answer regardless.
    }
  }

  return {
    get seq() {
      return seq
    },
    flush,
    wrap: (inner) => (input) =>
      inner({
        ...input,
        onDelta: (text) => {
          if (!text) return
          if (!buffer) oldestAt = now()
          buffer += text
          if (buffer.length >= maxChars || now() - oldestAt >= maxMs) flush()
        },
      }),
  }
}
