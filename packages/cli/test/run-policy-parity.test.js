import { describe, expect, it } from "vitest"
import { NUDGE_LIMIT } from "../../core/src/run-policy"
import { runAgent } from "../src/runner.js"

describe("run policy: parity with @derive/core/run-policy", () => {
  // The POLICY half of executor parity: how many times to re-ask, and how spend adds up. The
  // runner and the in-process turn must agree, or the same job would retry a different number
  // of times, or report a different cost, depending on where it happened to run.
  //
  // Driven through the REAL runAgent with a scripted provider. A first attempt at this asserted
  // on the source text and on a re-implementation of the accumulator, which tested neither.

  /** A provider that never emits the required block, so the nudge path is the one exercised. */
  const scripted = (turns) => {
    const calls = []
    return {
      calls,
      name: "scripted",
      run: async (opts) => {
        calls.push(opts.prompt)
        return turns[Math.min(calls.length - 1, turns.length - 1)]
      },
      retryable: () => false,
      version: async () => "test",
    }
  }
  const bare = (over = {}) => ({
    timedOut: false,
    code: 0,
    resultText: "no block here",
    sessionId: "sess-1",
    stderr: "",
    lastText: "",
    isError: false,
    apiErrorStatus: null,
    costUsd: null,
    ...over,
  })

  it("nudges exactly ONCE (NUDGE_LIMIT), then salvages instead of asking again", async () => {
    // A second reminder pays again for the same failure: a model that ignored the contract twice
    // ignores it a third time. Two spawns total — the attempt and the single nudge — and then the
    // raw reply is kept rather than the completed work thrown away.
    const provider = scripted([bare()])
    const out = await runAgent(provider, {
      bin: "x",
      cwd: ".",
      model: "m",
      systemPrompt: "s",
      prompt: "p",
      timeoutMs: 5_000,
    })
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("no block here")
    expect(provider.calls).toHaveLength(NUDGE_LIMIT + 1)
  })

  it("accumulates reported cost across attempts, and null stays UNKNOWN", async () => {
    // The real meter, not a copy of it. Null must not read as zero — the workspace budget sums
    // these, so an unreported run cannot look free.
    const provider = scripted([bare({ costUsd: 0.01 }), bare({ costUsd: 0.02 })])
    const meter = { costUsd: null }
    await runAgent(provider, {
      bin: "x",
      cwd: ".",
      model: "m",
      systemPrompt: "s",
      prompt: "p",
      timeoutMs: 5_000,
      meter,
    })
    expect(meter.costUsd).toBeCloseTo(0.03, 6)

    const silent = { costUsd: null }
    await runAgent(scripted([bare()]), {
      bin: "x",
      cwd: ".",
      model: "m",
      systemPrompt: "s",
      prompt: "p",
      timeoutMs: 5_000,
      meter: silent,
    })
    expect(silent.costUsd).toBeNull()
  })
})
