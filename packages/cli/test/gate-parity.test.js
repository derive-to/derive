import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIDENCE_FLOOR, decideWrite } from "../src/runner.js"

// GATE PARITY — the CLI's decideWrite must agree with @derive/core's, decision for decision.
//
// The CLI ships a hand-copied implementation on purpose: it is a dependency-free published
// package (its only dependency is fflate) and cannot import the TS core at runtime. That copy
// had NO test of any kind, which meant the two could silently disagree — and this is the
// autonomy gate, so a disagreement is not a cosmetic bug. It decides whether an agent's write
// goes live or waits for a human.
//
// The concrete risk is a rung added to one copy and not the other. That already nearly happened
// with `tainted`: a taint rung present in core but missing here would let a run that consumed
// untrusted webhook content live-publish from the container substrate while the same run was
// correctly demoted everywhere else.
//
// The table below is derived by the SAME precedence block as packages/core/test/autonomy.test.ts.
// Both are the spec; each holds its own implementation to it. Changing the precedence means
// changing both tables, and forgetting either implementation fails loudly here.
describe("decideWrite: parity with @derive/core", () => {
  it("the full truth table — 72 combinations, identical to core's", () => {
    const rows = []
    for (const autonomy of ["shadow", "suggest", "auto"])
      for (const confidence of [null, 0.5, 1])
        for (const killswitch of [false, true])
          for (const autoEnabled of [false, true])
            for (const tainted of [false, true]) {
              const expected = killswitch
                ? "proposal"
                : autonomy === "shadow"
                  ? "shadow"
                  : tainted
                    ? "proposal"
                    : autonomy === "suggest"
                      ? "proposal"
                      : !autoEnabled || confidence === null || confidence < DEFAULT_CONFIDENCE_FLOOR
                        ? "proposal"
                        : "live_publish_with_review"
              rows.push([autonomy, confidence, killswitch, autoEnabled, tainted, expected])
            }
    expect(rows).toHaveLength(72)
    for (const [autonomy, confidence, killswitch, autoEnabled, tainted, expected] of rows) {
      expect(
        decideWrite({
          autonomy,
          confidence,
          tainted,
          flags: { agentKillswitch: killswitch, agentAutoEnabled: autoEnabled },
        }),
        `${autonomy}/conf=${confidence}/kill=${killswitch}/auto=${autoEnabled}/taint=${tainted}`,
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
