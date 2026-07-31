import { log } from "../log"
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
/**
 * How many consecutive slices must reach nobody before the turn stops publishing.
 *
 * Not one: the client cannot subscribe until it knows the session is unsettled, which costs a
 * round trip after the POST, so a quick model can emit its first slice into an empty room. At
 * the flush cadence three misses is under a second of tolerance — long enough to lose the race
 * gracefully, short enough that a genuinely unwatched turn goes quiet almost at once.
 */
export const MISSES_BEFORE_QUIET = 3

/**
 * Where the prose stops and the machinery starts.
 *
 * The attended reply contract asks the model to answer in prose and then END with a single
 * `<revision>` (or `<edits>`) block whose JSON carries the COMPLETE new document source. The
 * settled transcript never shows that — `proseOf` strips it in turn-core once the loop
 * returns — but the stream is upstream of all of it, so without this the person watching sees
 * their answer followed by twelve kilobytes of escaped JSON scrolling past, on the single most
 * common chat action there is: asking for a change.
 *
 * The contract guarantees prose comes FIRST, so a prefix check is enough; no parser needed.
 */
const BLOCK_MARKERS = ["<revision", "<edits"] as const
/** Longest marker minus one: the most that could be a marker split across two slices. */
const MARKER_HOLDBACK = Math.max(...BLOCK_MARKERS.map((m) => m.length)) - 1

/** Index where the reply stops being prose, or -1 while it is all still prose. */
const blockStart = (s: string): number => {
  let at = -1
  for (const m of BLOCK_MARKERS) {
    const i = s.indexOf(m)
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  return at
}

export interface DeltaStream {
  /** Wrap `callModel` so its text deltas publish, coalesced.
   *
   *  Wrapping the CALL rather than threading an `onDelta` parameter through runSessionTurn →
   *  runTurn → agent-loop keeps every one of those layers untouched: they pass `callModel`
   *  along as they always have, and the streaming decision stays where the transport is known. */
  wrap(inner: AgentLoopInput["callModel"]): AgentLoopInput["callModel"]
  /** Publish anything still buffered. Call before settling the turn. */
  flush(): void
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
  publish: (slice: { seq: number; text: string; attempt: number }) => void | Promise<number>
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
  // Flipped off once several slices in a row reach nobody. Most turns have no watcher — an MCP
  // `use()` ask, an API caller, a tab closed mid-generation — and for those every publish is
  // waste, so this is the single biggest saving here: those turns settle down to a couple of
  // Durable Object fetches instead of tens.
  //
  // WHY NOT STOP ON THE FIRST ZERO. There is a startup race, and stopping on one reading loses
  // to it every time a model is quick. The client cannot subscribe until it knows the session
  // is unsettled, which costs it a round trip after the POST; a model that emits its first
  // token before that lands would publish to an empty room, and a single-reading rule would
  // then disable streaming for the whole turn. This was not theoretical — it is exactly what
  // the context console did on the preview: the reply arrived, and not one delta with it.
  // Requiring consecutive misses tolerates the race (a few hundred ms at the flush cadence)
  // while still going quiet almost immediately for a turn nobody is actually watching.
  //
  // A reader who opens the page mid-answer is not stranded either way: the terminal
  // `session.settled` still fires, and settling is what makes a client re-read the transcript.
  // They lose the animation, not the answer.
  let streaming = true
  let consecutiveMisses = 0
  // Which model ATTEMPT these slices belong to.
  //
  // The agent loop may call the model more than once for a single answer: attended chat runs
  // `maxTurns: NUDGE_LIMIT + 1`, so a reply that misses the reply contract is nudged and
  // re-generated. The first attempt's text is DISCARDED — only the last one becomes the
  // transcript. Without this counter a client would append the abandoned attempt to the real
  // one and show a garbled reply that never matches what gets persisted. Slices carry the
  // attempt they came from so a reader can drop everything older the moment a new one starts.
  let attempt = 0
  // Everything the model has emitted for THIS attempt, and how much of it has been queued for
  // publication. Tracked separately from `buffer` because what the reader should see is a
  // prefix of the reply, not all of it — see BLOCK_MARKERS.
  let seen = ""
  let published = 0
  // Latched once the reply reaches its machinery block: nothing after it is ever shown.
  let suppressed = false

  const flushBuffer = () => {
    if (!buffer || !streaming) return
    seq += 1
    const slice = { seq, text: buffer, attempt }
    buffer = ""
    oldestAt = 0
    try {
      const receipt = opts.publish(slice)
      // Every slice is probed, not just the first — the count is what the publish already
      // returns, so reading it costs nothing extra, and a watcher can arrive or leave mid-turn.
      if (receipt && typeof receipt.then === "function")
        void receipt
          .then((delivered) => {
            // A reader who shows up later resets the count, so arriving mid-answer starts the
            // animation rather than finding a stream that already gave up.
            consecutiveMisses = delivered === 0 ? consecutiveMisses + 1 : 0
            if (consecutiveMisses >= MISSES_BEFORE_QUIET && streaming) {
              streaming = false
              // Without this line the three states — "the gateway isn't streaming", "the realtime
              // room is broken", and "nobody was watching" — are indistinguishable in production,
              // because all three look like a reply that simply arrived whole.
              log.info("session stream: no listener, going quiet", { slices: seq })
            }
          })
          .catch(() => {
            /* an unanswerable probe is not a reason to stop streaming */
          })
    } catch (e) {
      // A transport blip must not abort a turn the model has already been paid for. The
      // transcript still lands on settle, so the reader gets the whole answer regardless — but
      // a backplane rejecting every publish should not be silent.
      log.warn("session stream: publish failed", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** Queue the prose up to `upto` that has not been queued yet. */
  const queue = (upto: string) => {
    if (upto.length <= published) return
    if (!buffer) oldestAt = now()
    buffer += upto.slice(published)
    published = upto.length
  }

  return {
    // Release the held-back tail (nothing more is coming, so it cannot be a partial marker)
    // and publish whatever is left. Called once, by `reply()`, before the turn settles.
    flush: () => {
      if (!suppressed) queue(seen)
      flushBuffer()
    },
    wrap: (inner) => (input) => {
      // A new model attempt. Everything about the previous one is dropped rather than flushed —
      // publishing it would put text on screen the transcript is never going to contain.
      attempt += 1
      buffer = ""
      oldestAt = 0
      seen = ""
      published = 0
      suppressed = false
      return inner({
        ...input,
        onDelta: (text) => {
          // Once nobody is listening, stop even ACCUMULATING: the returned ModelTurn is the
          // answer, so buffering text no one will receive just holds memory for the turn.
          if (!text || !streaming || suppressed) return
          seen += text
          const cut = blockStart(seen)
          if (cut !== -1) {
            // The prose ended and the machinery began. Show the prose, then go quiet for the
            // rest of this attempt.
            queue(seen.slice(0, cut))
            suppressed = true
            flushBuffer()
            return
          }
          // Hold back a marker-length tail: `<revi` now could be `<revision` next slice, and
          // showing it and retracting it would be worse than showing it a beat later.
          queue(seen.slice(0, Math.max(0, seen.length - MARKER_HOLDBACK)))
          if (buffer.length >= maxChars || now() - oldestAt >= maxMs) flushBuffer()
        },
      })
    },
  }
}
