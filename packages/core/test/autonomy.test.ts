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
  flags: { agentKillswitch: false, agentAutoEnabled: true, credentialed: false },
}

describe("decideWrite", () => {
  it("the full truth table — every combination lands where the precedence says", () => {
    // The SPEC, expressed as data. packages/cli/test/gate-parity.test.js derives its expectation
    // with an identical block, because the CLI ships a hand-copied decideWrite — it is a
    // dependency-free published package and cannot import this one at runtime. Change the
    // precedence here and both tables must change with it; if the CLI's IMPLEMENTATION is not
    // updated too, its parity test fails. That is the only thing standing between two copies of
    // a safety gate and a silent divergence.
    const rows: Array<[AutonomyLevel, number | null, boolean, boolean, boolean, GateDecision]> = []
    for (const autonomy of ["shadow", "suggest", "auto"] as const)
      for (const confidence of [null, 0.5, 1])
        for (const killswitch of [false, true])
          for (const autoEnabled of [false, true])
            for (const credentialed of [false, true]) {
              const expected: GateDecision = killswitch
                ? "proposal"
                : autonomy === "shadow"
                  ? "shadow"
                  : credentialed
                    ? "proposal"
                    : autonomy === "suggest"
                      ? "proposal"
                      : !autoEnabled || confidence === null || confidence < DEFAULT_CONFIDENCE_FLOOR
                        ? "proposal"
                        : "live_publish_with_review"
              rows.push([autonomy, confidence, killswitch, autoEnabled, credentialed, expected])
            }
    expect(rows).toHaveLength(72)
    for (const [autonomy, confidence, killswitch, autoEnabled, credentialed, expected] of rows) {
      expect(
        decideWrite({
          autonomy,
          confidence,
          flags: { agentKillswitch: killswitch, agentAutoEnabled: autoEnabled, credentialed },
        }),
        `${autonomy}/conf=${confidence}/kill=${killswitch}/auto=${autoEnabled}/cred=${credentialed}`,
      ).toBe(expected)
    }
  })

  it("a run that can spend a credential proposes, and never live-publishes", () => {
    // The invariant the plan documents as "taint": a run holding a real credential is exactly
    // the case where an unreviewed live publish is worst, so it is demoted no matter how
    // confident the model is or how opted-in the workspace is.
    expect(decideWrite({ ...base, flags: { ...base.flags, credentialed: true } })).toBe("proposal")
    // Shadow still outranks it: filing nothing is safer than filing a proposal, so a shadow
    // rollout does not get louder just because the run had a key.
    expect(
      decideWrite({
        ...base,
        autonomy: "shadow",
        flags: { ...base.flags, credentialed: true },
      }),
    ).toBe("shadow")
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
