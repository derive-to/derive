import { describe, expect, it } from "vitest"
import {
  type AutonomyLevel,
  type ChangeKind,
  DEFAULT_CONFIDENCE_FLOOR,
  decideWrite,
  type GateDecision,
} from "../src/autonomy"

const base = {
  autonomy: "auto" as AutonomyLevel,
  changeKind: "freshness" as ChangeKind,
  confidence: 1,
  flags: { agentKillswitch: false, agentAutoEnabled: true },
}

describe("decideWrite", () => {
  it("the full truth table — every combination lands where the precedence says", () => {
    const rows: Array<[AutonomyLevel, ChangeKind, number | null, boolean, boolean, GateDecision]> =
      []
    for (const autonomy of ["shadow", "suggest", "auto"] as const)
      for (const changeKind of ["freshness", "structural"] as const)
        for (const confidence of [null, 0.5, 1])
          for (const killswitch of [false, true])
            for (const autoEnabled of [false, true]) {
              const expected: GateDecision = killswitch
                ? "proposal"
                : autonomy === "shadow"
                  ? "shadow"
                  : autonomy === "suggest"
                    ? "proposal"
                    : !autoEnabled ||
                        changeKind === "structural" ||
                        confidence === null ||
                        confidence < DEFAULT_CONFIDENCE_FLOOR
                      ? "proposal"
                      : "live_publish_with_review"
              rows.push([autonomy, changeKind, confidence, killswitch, autoEnabled, expected])
            }
    expect(rows).toHaveLength(72)
    for (const [autonomy, changeKind, confidence, killswitch, autoEnabled, expected] of rows) {
      expect(
        decideWrite({
          autonomy,
          changeKind,
          confidence,
          flags: { agentKillswitch: killswitch, agentAutoEnabled: autoEnabled },
        }),
        `${autonomy}/${changeKind}/conf=${confidence}/kill=${killswitch}/auto=${autoEnabled}`,
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

  it("only a confident freshness change on an opted-in workspace publishes live", () => {
    expect(decideWrite(base)).toBe("live_publish_with_review")
    expect(decideWrite({ ...base, changeKind: "structural" })).toBe("proposal")
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
