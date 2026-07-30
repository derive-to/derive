import { describe, expect, it } from "vitest"
import {
  type AutonomyLevel,
  DEFAULT_CONFIDENCE_FLOOR,
  decideWrite,
  type GateDecision,
} from "../src/autonomy"

const base = {
  autonomy: "auto" as AutonomyLevel,
  confidence: 1,
  flags: { agentKillswitch: false, agentAutoEnabled: true },
}

describe("decideWrite", () => {
  it("the full truth table — every combination lands where the precedence says", () => {
    // The SPEC, expressed as data. packages/cli/test/gate-parity.test.js derives its expectation
    // with an identical block, because the CLI ships a hand-copied decideWrite — it is a
    // dependency-free published package and cannot import this one at runtime. Change the
    // precedence here and both tables must change with it; if the CLI's IMPLEMENTATION is not
    // updated too, its parity test fails. That is the only thing standing between two copies of
    // a safety gate and a silent divergence.
    const rows: Array<[AutonomyLevel, number | null, boolean, boolean, GateDecision]> = []
    for (const autonomy of ["shadow", "suggest", "auto"] as const)
      for (const confidence of [null, 0.5, 1])
        for (const killswitch of [false, true])
          for (const autoEnabled of [false, true]) {
            const expected: GateDecision = killswitch
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

  it("the killswitch outranks everything, including shadow — work surfaces, never drops", () => {
    expect(
      decideWrite({
        ...base,
        autonomy: "shadow",
        flags: { agentKillswitch: true, agentAutoEnabled: true },
      }),
    ).toBe("proposal")
  })

  it("only a confident publish-consented write on an opted-in workspace goes live", () => {
    expect(decideWrite(base)).toBe("live_publish_with_review")
    expect(decideWrite({ ...base, confidence: null })).toBe("proposal")
    expect(decideWrite({ ...base, confidence: 0.79 })).toBe("proposal")
    expect(
      decideWrite({ ...base, flags: { agentKillswitch: false, agentAutoEnabled: false } }),
    ).toBe("proposal")
  })

  it("the confidence floor is adjustable and boundary-inclusive", () => {
    expect(decideWrite({ ...base, confidence: 0.6, confidenceFloor: 0.6 })).toBe(
      "live_publish_with_review",
    )
    expect(decideWrite({ ...base, confidence: 0.59, confidenceFloor: 0.6 })).toBe("proposal")
    expect(decideWrite({ ...base, confidence: DEFAULT_CONFIDENCE_FLOOR })).toBe(
      "live_publish_with_review",
    )
  })
})
