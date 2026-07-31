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
  const stream = makeDeltaStream({ publish: (s) => sent.push(s), ...over })
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
