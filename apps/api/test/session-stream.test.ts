import { describe, expect, it } from "vitest"
import type { AgentLoopInput } from "../src/lib/agent-loop"
import { DELTA_FLUSH_CHARS, makeDeltaStream } from "../src/lib/session-stream"

/**
 * Coalescing is the whole reason this file exists: one publish per token would be one Durable
 * Object fetch per token. These pin the boundaries it flushes on, that it never invents or
 * loses text, and that a broken transport cannot take the reply down with it.
 */

/** A fake callModel that emits the given pieces through `onDelta`, then returns a whole turn. */
const emitting = (pieces: string[]): AgentLoopInput["callModel"] =>
  (async ({ onDelta }) => {
    for (const p of pieces) onDelta?.(p)
    return { text: pieces.join(""), toolUses: [], costUsd: null, done: true }
  }) as AgentLoopInput["callModel"]

const harness = (over: { now?: () => number; flushChars?: number; flushMs?: number } = {}) => {
  const sent: { seq: number; text: string }[] = []
  const stream = makeDeltaStream({
    publish: (s) => {
      sent.push(s)
    },
    ...over,
  })
  return { sent, stream }
}

const call = (fn: AgentLoopInput["callModel"]) => fn({ system: "", messages: [], tools: [] })

describe("delta coalescing", () => {
  it("buffers small pieces instead of publishing each one", async () => {
    // A frozen clock: only the SIZE boundary can fire, so this isolates it from the age one.
    const { sent, stream } = harness({ now: () => 0 })
    await call(stream.wrap(emitting(["a", "b", "c"])))
    expect(sent).toEqual([]) // still buffered — three tokens are not three publishes
    stream.flush()
    expect(sent).toMatchObject([{ seq: 1, text: "abc" }])
  })

  it("flushes on the size boundary mid-reply", async () => {
    const { sent, stream } = harness({ now: () => 0 })
    const big = "x".repeat(DELTA_FLUSH_CHARS * 2)
    await call(stream.wrap(emitting([big, "tail"])))
    // The size boundary fired mid-reply rather than everything waiting for the final flush.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.seq).toBe(1)
    expect(sent[0]?.text.length).toBeGreaterThanOrEqual(DELTA_FLUSH_CHARS)
    stream.flush()
    // Nothing is lost across the boundary: the slices concatenate to the whole reply. The split
    // is not exactly at `big` because a marker-length tail is held back (see MARKER_HOLDBACK).
    expect(sent.map((s) => s.text).join("")).toBe(`${big}tail`)
  })

  it("flushes on the age boundary when the model is slow", async () => {
    let t = 0
    const { sent, stream } = harness({ now: () => t, flushMs: 50 })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      onDelta?.("slow reply that is comfortably longer than the marker holdback ")
      t = 100 // the next token arrives well after the age boundary
      onDelta?.("and then some more")
      return { text: "x", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await call(wrapped)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("slow reply that is comfortably longer")
  })

  it("never loses or reorders text, whatever the boundaries", async () => {
    const { sent, stream } = harness({ now: () => 0, flushChars: 3 })
    const pieces = ["The ", "quick ", "brown ", "fox ", "jumps"]
    const turn = await call(stream.wrap(emitting(pieces)))
    stream.flush()
    // Every slice concatenated is exactly the reply, and the seqs are 1..n with no gaps.
    expect(sent.map((s) => s.text).join("")).toBe(pieces.join(""))
    expect(sent.map((s) => s.seq)).toEqual(sent.map((_, i) => i + 1))
    // ...and the RETURNED turn is untouched by any of this.
    expect(turn.text).toBe("The quick brown fox jumps")
  })

  it("a publish that throws does not fail the turn", async () => {
    const stream = makeDeltaStream({
      now: () => 0,
      publish: () => {
        throw new Error("the room is gone")
      },
    })
    const turn = await call(stream.wrap(emitting(["still ", "answered"])))
    stream.flush()
    // The transcript still lands on settle — a dead transport costs the animation, not the reply.
    expect(turn.text).toBe("still answered")
  })
})

// ---- Cost control ---------------------------------------------------------
// Each publish is a Durable Object fetch on the hosted tier, so how OFTEN this publishes is a
// real bill, not a detail. Two levers: the age boundary (which is the one that actually fires),
// and switching off entirely when no tab is listening — which is most turns.

describe("publish cost", () => {
  it("the age boundary, not the size one, sets the rate for a normal model", async () => {
    // ~300 chars/sec, the shape of a real reply: 30 chars every 100ms.
    let t = 0
    const sent: { seq: number; text: string }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s)
      },
      now: () => t,
      flushMs: 250,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      for (let i = 0; i < 60; i++) {
        onDelta?.("x".repeat(30))
        t += 100
      }
      return { text: "", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await wrapped({ system: "", messages: [], tools: [] })
    stream.flush()
    // Six seconds of generation. At the old 80ms boundary this would have been ~60 publishes;
    // the size cap alone would never have bounded it, because 250ms of text is under 200 chars.
    expect(sent.length).toBeLessThanOrEqual(25)
    expect(sent.length).toBeGreaterThan(5) // still genuinely streaming, not one lump at the end
  })

  it("stops publishing once several slices in a row reach nobody", async () => {
    let t = 0
    const sent: { seq: number; text: string }[] = []
    const stream = makeDeltaStream({
      // Zero live streams: the tab is closed, or this is an MCP/API ask with no browser at all.
      publish: (s) => {
        sent.push(s)
        return Promise.resolve(0)
      },
      now: () => t,
      flushMs: 10,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      onDelta?.("first")
      t += 100
      onDelta?.("second") // flushes, and the probe from the first resolves around here
      await Promise.resolve()
      await Promise.resolve()
      for (let i = 0; i < 50; i++) {
        onDelta?.("more")
        t += 100
        await Promise.resolve() // real streaming awaits each read; receipts settle between slices
      }
      return { text: "whole answer", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    const turn = await wrapped({ system: "", messages: [], tools: [] })
    stream.flush()
    // A few slices go out while the misses accumulate; then it goes quiet for good, instead of
    // paying ~50 more DO fetches for a reply nobody is watching.
    expect(sent.length).toBeLessThanOrEqual(6)
    // ...and the ANSWER is completely unaffected — that is the whole safety argument.
    expect(turn.text).toBe("whole answer")
  })
})

describe("the startup race", () => {
  it("keeps streaming when a reader attaches a moment after the model starts", async () => {
    // THE BUG THIS PINS. The client cannot subscribe until it knows the session is unsettled,
    // which costs a round trip after the POST. A quick model publishes its first slice into an
    // empty room — and a rule that stopped on ONE miss disabled streaming for the whole turn.
    // Observed live on the preview: the context console's reply arrived with zero deltas.
    let t = 0
    let listeners = 0 // nobody yet
    const sent: { seq: number; text: string }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s)
        return Promise.resolve(listeners)
      },
      now: () => t,
      flushMs: 10,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      // Two slices land before the reader is attached.
      onDelta?.("first ")
      t += 100
      onDelta?.("second ")
      t += 100
      await Promise.resolve()
      listeners = 1 // the tab finishes subscribing
      for (let i = 0; i < 10; i++) {
        onDelta?.("more ")
        t += 100
        await Promise.resolve()
      }
      return { text: "done", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await wrapped({ system: "", messages: [], tools: [] })
    stream.flush()
    // It survived the gap and kept streaming, rather than giving up on the first empty room.
    expect(sent.length).toBeGreaterThanOrEqual(6)
  })

  it("a reader arriving mid-answer resets the miss count", async () => {
    let t = 0
    let listeners = 0
    const sent: { seq: number; text: string }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s)
        return Promise.resolve(listeners)
      },
      now: () => t,
      flushMs: 10,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      // Two misses — one short of going quiet — then somebody opens the page.
      for (let i = 0; i < 2; i++) {
        onDelta?.("a chunk long enough to clear the holdback ")
        t += 100
        await Promise.resolve()
      }
      listeners = 1
      for (let i = 0; i < 6; i++) {
        onDelta?.("another chunk long enough to clear the holdback ")
        t += 100
        await Promise.resolve()
      }
      return { text: "", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await wrapped({ system: "", messages: [], tools: [] })
    // Slices flush every other delta, so eight deltas is four slices — the point is that it
    // kept publishing AFTER the early miss instead of latching quiet at the threshold.
    expect(sent.length).toBeGreaterThanOrEqual(4)
  })
})

describe("a re-generated reply", () => {
  it("marks a new attempt so a reader replaces rather than appends", async () => {
    // THE BUG THIS PINS. The agent loop can call the model more than once for ONE answer:
    // attended chat runs maxTurns = NUDGE_LIMIT + 1, so a reply that misses the reply contract
    // is nudged and generated again. Only the LAST attempt becomes the transcript. Without an
    // attempt marker a client appends the abandoned text to the real text and shows a garbled
    // answer that the settled message then contradicts.
    let t = 0
    const sent: { seq: number; text: string; attempt: number }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s)
      },
      now: () => t,
      flushMs: 10,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      onDelta?.("bad attempt ")
      t += 100
      onDelta?.("text")
      return { text: "bad attempt text", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])

    // Attempt 1 — the reply the contract rejects.
    await wrapped({ system: "", messages: [], tools: [] })
    stream.flush()
    // Attempt 2 — the loop re-asks through the SAME wrapped callModel.
    await wrapped({ system: "", messages: [], tools: [] })
    stream.flush()

    const attempts = sent.map((s) => s.attempt)
    expect(Math.min(...attempts)).toBe(1)
    expect(Math.max(...attempts)).toBe(2)
    // Every slice says which attempt it belongs to, so a client can drop the abandoned one.
    expect(sent.filter((s) => s.attempt === 1).length).toBeGreaterThan(0)
    expect(sent.filter((s) => s.attempt === 2).length).toBeGreaterThan(0)
    // Sequence stays globally monotonic across attempts, so the reorder guard still works.
    expect(sent.map((s) => s.seq)).toEqual([...sent.map((s) => s.seq)].sort((a, b) => a - b))
  })

  it("drops text still buffered from an attempt that was abandoned", async () => {
    // Text the model emitted but that never flushed belongs to a reply being thrown away.
    // Publishing it later would put words on screen the transcript will never contain.
    const sent: { seq: number; text: string; attempt: number }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s)
      },
      now: () => 0, // frozen: nothing reaches the age boundary, so it all stays buffered
    })
    const first = stream.wrap((async ({ onDelta }) => {
      onDelta?.("abandoned")
      return { text: "abandoned", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await first({ system: "", messages: [], tools: [] })
    // No flush between attempts — the next call must discard that buffer, not inherit it.
    const second = stream.wrap((async ({ onDelta }) => {
      onDelta?.("real answer")
      return { text: "real answer", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await second({ system: "", messages: [], tools: [] })
    stream.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe("real answer")
    expect(sent[0]?.text).not.toContain("abandoned")
  })
})

describe("the machinery block never reaches the reader", () => {
  // The attended contract asks the model to answer in prose and then END with a <revision>
  // block whose JSON carries the COMPLETE new document source. proseOf strips it from the
  // TRANSCRIPT, but the stream is upstream of that — so without a cut the person watching sees
  // their answer followed by kilobytes of escaped JSON, on the commonest action there is.
  const revision = `<revision>${JSON.stringify({ content: "<!doctype html><html>…".repeat(50), filename: "d.html" })}</revision>`

  it("streams the prose and stops dead at the block", async () => {
    const { sent, stream } = harness({ now: () => 0 })
    await call(
      stream.wrap(emitting(["I shortened the intro and tightened the headings. ", revision])),
    )
    stream.flush()
    const shown = sent.map((s) => s.text).join("")
    expect(shown).toBe("I shortened the intro and tightened the headings. ")
    expect(shown).not.toContain("<revision")
    expect(shown).not.toContain("doctype")
  })

  it("cuts even when the marker is split across slices", async () => {
    // `<revi` in one slice and `sion>` in the next must not leak the opening tag.
    const { sent, stream } = harness({ now: () => 0 })
    await call(stream.wrap(emitting(["Done. ", "<revi", "sion>", '{"content":"secret"}'])))
    stream.flush()
    const shown = sent.map((s) => s.text).join("")
    expect(shown).toBe("Done. ")
    expect(shown).not.toContain("<")
    expect(shown).not.toContain("secret")
  })
})
