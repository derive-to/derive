import { describe, expect, it } from "vitest"
import {
  DEFAULT_EXECUTION_PROVIDER,
  EXECUTION_PROVIDERS,
  parseRunExecution,
} from "../src/execution"
import { addCostUsd, toMicroUsd } from "../src/run-policy"

// The spend arithmetic and the execution snapshot are core's; the CLI's hand copies are held
// to them by packages/cli/test/run-policy-parity.test.js. These pin core's own behavior.

describe("addCostUsd — null is UNKNOWN, never zero", () => {
  it("accumulates across attempts; null plus a number is that number", () => {
    expect(addCostUsd(null, 0.01)).toBeCloseTo(0.01)
    expect(addCostUsd(0.01, 0.02)).toBeCloseTo(0.03)
  })
  it("null plus null stays null — a run that never reported must not look free", () => {
    expect(addCostUsd(null, null)).toBeNull()
    expect(addCostUsd(null, undefined)).toBeNull()
  })
  it("a non-finite report is ignored rather than poisoning the total", () => {
    expect(addCostUsd(0.05, Number.NaN)).toBeCloseTo(0.05)
    expect(addCostUsd(0.05, Number.POSITIVE_INFINITY)).toBeCloseTo(0.05)
  })
})

describe("toMicroUsd — integer micros, rounded up", () => {
  it("rounds UP so a sub-micro run is never free", () => {
    expect(toMicroUsd(0.0000001)).toBe(1)
    expect(toMicroUsd(0.004)).toBe(4000)
  })
  it("null/negative/non-finite in → null out", () => {
    expect(toMicroUsd(null)).toBeNull()
    expect(toMicroUsd(undefined)).toBeNull()
    expect(toMicroUsd(-1)).toBeNull()
    expect(toMicroUsd(Number.NaN)).toBeNull()
  })
})

describe("parseRunExecution — the immutable enqueue-time snapshot", () => {
  it("falls back for historical rows with no snapshot, defaulting hosted", () => {
    expect(parseRunExecution({})).toEqual({
      version: 1,
      provider: DEFAULT_EXECUTION_PROVIDER,
      location: "hosted",
      model: null,
    })
    expect(parseRunExecution({ execution: "junk" }, "codex").provider).toBe("codex")
  })
  it("an unknown provider falls back whole; junk location/model degrade field-wise", () => {
    expect(parseRunExecution({ execution: { provider: "gemini" } }).provider).toBe(
      DEFAULT_EXECUTION_PROVIDER,
    )
    const odd = parseRunExecution({
      execution: { provider: "claude-code", location: "moon", model: "" },
    })
    expect(odd).toEqual({ version: 1, provider: "claude-code", location: "hosted", model: null })
    expect(EXECUTION_PROVIDERS).toContain(odd.provider)
  })
})
