import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIDENCE_FLOOR, decideWrite, runRevisionAgent } from "../src/runner.js"

// GATE PARITY — the CLI's decideWrite must agree with @derive/core's, decision for decision.
//
// The CLI ships a hand-copied implementation on purpose: it is a dependency-free published
// package (its only dependency is fflate) and cannot import the TS core at runtime. That copy
// had NO test of any kind, which meant the two could silently disagree — and this is the
// autonomy gate, so a disagreement is not a cosmetic bug. It decides whether an agent's write
// goes live or waits for a human.
//
// The concrete risk is a rung added to one copy and not the other: a rung present in core but
// missing here would let the container substrate live-publish a write that is correctly demoted
// everywhere else.
//
// The table below is derived by the SAME precedence block as packages/core/test/autonomy.test.ts.
// Both are the spec; each holds its own implementation to it. Changing the precedence means
// changing both tables, and forgetting either implementation fails loudly here.
describe("decideWrite: parity with @derive/core", () => {
  it("the full truth table — 36 combinations, identical to core's", () => {
    const rows = []
    for (const autonomy of ["shadow", "suggest", "auto"])
      for (const confidence of [null, 0.5, 1])
        for (const killswitch of [false, true])
          for (const autoEnabled of [false, true]) {
            const expected = killswitch
              ? "proposal"
              : autonomy === "shadow"
                ? "shadow"
                : autonomy === "suggest"
                  ? "proposal"
                  : !autoEnabled || confidence === null || confidence < DEFAULT_CONFIDENCE_FLOOR
                    ? "proposal"
                    : "live_publish_with_review"
            rows.push([autonomy, confidence, killswitch, autoEnabled, expected])
          }
    expect(rows).toHaveLength(36)
    for (const [autonomy, confidence, killswitch, autoEnabled, expected] of rows) {
      expect(
        decideWrite({
          autonomy,
          confidence,
          flags: { agentKillswitch: killswitch, agentAutoEnabled: autoEnabled },
        }),
        `${autonomy}/conf=${confidence}/kill=${killswitch}/auto=${autoEnabled}`,
      ).toBe(expected)
    }
  })

  it("the confidence floor constant matches core's", () => {
    // A drifted floor is the quietest possible divergence: every decision still looks plausible,
    // and only writes sitting between the two thresholds land differently depending on which
    // substrate happened to run them.
    expect(DEFAULT_CONFIDENCE_FLOOR).toBe(0.8)
  })

  it("treats an undefined confidence like a null one", () => {
    // The JS copy takes `confidence === null || confidence === undefined`; the TS copy relies on
    // its type to exclude undefined. A JSON payload with the key omitted reaches the CLI as
    // undefined, so this is the case where the two could differ for a real input rather than a
    // hypothetical one — an unstated confidence must never auto-publish.
    expect(
      decideWrite({
        autonomy: "auto",
        confidence: undefined,
        flags: { agentKillswitch: false, agentAutoEnabled: true },
      }),
    ).toBe("proposal")
  })
})

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
    expect(provider.calls).toHaveLength(2)
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
