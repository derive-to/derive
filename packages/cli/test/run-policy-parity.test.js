import { describe, expect, it } from "vitest"
import { NUDGE_LIMIT } from "../../core/src/run-policy"
import { runRevisionAgent } from "../src/runner.js"

describe("run policy: parity with @derive/core/run-policy", () => {
  // The other half of executor parity. The CONTRACT (what output to ask for) is pinned by
  // contract-parity.test.js; this pins the POLICY — how many times to re-ask, and how spend adds
  // up. Both executors were deciding these separately, which is how two substrates quietly stop
  // being comparable: the same automation would retry a different number of times, or report a
  // different cost, depending on where it happened to run.
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

  it("nudges exactly ONCE (NUDGE_LIMIT), then gives up", async () => {
    // A second reminder pays again for the same failure: a model that ignored the contract twice
    // ignores it a third time. Two spawns total — the attempt and the single nudge.
    //
    // The RUN lane, deliberately: the answer lane salvages an unstructured reply rather than
    // discarding completed work, so it would succeed here and prove nothing about give-up.
    const provider = scripted([bare()])
    const out = await runRevisionAgent(provider, {
      bin: "x",
      cwd: ".",
      model: "m",
      systemPrompt: "s",
      prompt: "p",
      timeoutMs: 5_000,
    })
    expect(out.ok).toBe(false)
    expect(provider.calls).toHaveLength(NUDGE_LIMIT + 1)
  })

  it("accumulates reported cost across attempts, and null stays UNKNOWN", async () => {
    // The real meter, not a copy of it. Null must not read as zero — the workspace budget sums
    // these, so an unreported run cannot look free.
    const provider = scripted([bare({ costUsd: 0.01 }), bare({ costUsd: 0.02 })])
    const meter = { costUsd: null }
    await runRevisionAgent(provider, {
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
    await runRevisionAgent(scripted([bare()]), {
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
