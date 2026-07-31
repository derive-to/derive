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
/**
 * ...or when the oldest buffered text is this old, so a slow model still shows progress.
 *
 * THIS NUMBER IS THE COST DIAL, and it is the one that actually fires. A model emitting a few
 * hundred characters a second reaches the age boundary long before the size one, so the publish
 * rate is essentially `1000 / DELTA_FLUSH_MS` per second — at 80ms that is ~12 Durable Object
 * fetches a second, or ~250 for a twenty-second answer, which is exactly the many-small-round-
 * trips shape the rest of this work exists to remove. At 250ms it is 4 a second, and a reader
 * cannot tell the difference: prose arrives faster than anyone reads it either way.
 */
export const DELTA_FLUSH_MS = 250

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
  /**
   * Publish one coalesced slice.
   *
   * MAY RETURN A DELIVERY COUNT (a promise of how many live streams received it). When the
   * FIRST slice reports zero, streaming switches off for the rest of the turn — see the
   * no-listener note on `makeDeltaStream`. A `void` return means "no receipt available", and
   * streaming simply continues.
   */
  publish: (slice: { seq: number; text: string }) => void | Promise<number>
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
  // Flipped off when the first slice reports nobody received it. Most turns have no watcher —
  // an MCP `use()` ask, an API caller, a tab closed mid-generation — and for those every
  // further publish is pure waste. Costing one probe to skip the rest is the single biggest
  // saving here: those turns go from tens of Durable Object fetches to exactly one.
  //
  // A reader who opens the page mid-answer is not stranded: the terminal `session.settled`
  // still fires, and settling is what makes a client re-read the transcript. They lose the
  // animation, not the answer.
  let streaming = true

  const flush = () => {
    if (!buffer || !streaming) return
    seq += 1
    const slice = { seq, text: buffer }
    buffer = ""
    oldestAt = 0
    try {
      const receipt = opts.publish(slice)
      // Only the FIRST slice is probed. Later ones would pay a promise per publish to learn
      // something that rarely changes mid-turn.
      if (seq === 1 && receipt && typeof receipt.then === "function")
        void receipt
          .then((delivered) => {
            if (delivered === 0) streaming = false
          })
          .catch(() => {
            /* an unanswerable probe is not a reason to stop streaming */
          })
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
          // Once nobody is listening, stop even ACCUMULATING: the returned ModelTurn is the
          // answer, so buffering text no one will receive just holds memory for the turn.
          if (!text || !streaming) return
          if (!buffer) oldestAt = now()
          buffer += text
          if (buffer.length >= maxChars || now() - oldestAt >= maxMs) flush()
        },
      }),
  }
}
