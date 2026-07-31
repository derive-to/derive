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
    expect(sent).toEqual([{ seq: 1, text: "abc" }])
  })

  it("flushes on the size boundary mid-reply", async () => {
    const { sent, stream } = harness({ now: () => 0 })
    const big = "x".repeat(DELTA_FLUSH_CHARS)
    await call(stream.wrap(emitting([big, "tail"])))
    expect(sent).toEqual([{ seq: 1, text: big }])
    stream.flush()
    expect(sent[1]).toEqual({ seq: 2, text: "tail" })
  })

  it("flushes on the age boundary when the model is slow", async () => {
    let t = 0
    const { sent, stream } = harness({ now: () => t, flushMs: 50 })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      onDelta?.("slow ")
      t = 100 // the next token arrives well after the age boundary
      onDelta?.("reply")
      return { text: "slow reply", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await call(wrapped)
    expect(sent).toEqual([{ seq: 1, text: "slow reply" }])
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

  it("flush is idempotent, so settling twice cannot double-publish", async () => {
    const { sent, stream } = harness({ now: () => 0 })
    await call(stream.wrap(emitting(["once"])))
    stream.flush()
    stream.flush()
    expect(sent).toHaveLength(1)
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

  it("passes the rest of the input through untouched", async () => {
    const seen: unknown[] = []
    const { stream } = harness({ now: () => 0 })
    const wrapped = stream.wrap((async (input) => {
      seen.push({ system: input.system, tools: input.tools.length })
      return { text: "", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await wrapped({ system: "be helpful", messages: [], tools: [] })
    expect(seen[0]).toEqual({ system: "be helpful", tools: 0 })
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

  it("keeps streaming while someone is listening", async () => {
    let t = 0
    const sent: { seq: number; text: string }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s)
        return Promise.resolve(1) // one open tab
      },
      now: () => t,
      flushMs: 10,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      for (let i = 0; i < 10; i++) {
        onDelta?.("tick")
        t += 100
        await Promise.resolve()
      }
      return { text: "", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await wrapped({ system: "", messages: [], tools: [] })
    // 10 deltas at one flush per two ticks — the point is it never went quiet, not the exact count.
    expect(sent.length).toBeGreaterThanOrEqual(4)
  })

  it("a backplane that cannot count keeps streaming rather than going silent", async () => {
    let t = 0
    const sent: { seq: number; text: string }[] = []
    const stream = makeDeltaStream({
      publish: (s) => {
        sent.push(s) // void return: no receipt available
      },
      now: () => t,
      flushMs: 10,
    })
    const wrapped = stream.wrap((async ({ onDelta }) => {
      for (let i = 0; i < 8; i++) {
        onDelta?.("tick")
        t += 100
        await Promise.resolve()
      }
      return { text: "", toolUses: [], costUsd: null, done: true }
    }) as AgentLoopInput["callModel"])
    await wrapped({ system: "", messages: [], tools: [] })
    // No receipt to read, so it must keep going rather than assume nobody is there.
    expect(sent.length).toBeGreaterThanOrEqual(3)
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
        onDelta?.("x")
        t += 100
        await Promise.resolve()
      }
      listeners = 1
      for (let i = 0; i < 6; i++) {
        onDelta?.("y")
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
