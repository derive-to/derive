import { describe, expect, it } from "vitest"
import { parseVersionRange } from "../src/mcp-util"

// The version-range grammar for the data-slot trend read. Deliberately the same shape as
// `lines` (parseLineRange) so an agent only learns one range syntax, plus "all".
describe("parseVersionRange", () => {
  const CURRENT = 30

  it("reads the explicit forms", () => {
    expect(parseVersionRange("1-30", CURRENT)).toEqual({ from: 1, to: 30 })
    expect(parseVersionRange("5-9", CURRENT)).toEqual({ from: 5, to: 9 })
    expect(parseVersionRange("12", CURRENT)).toEqual({ from: 12, to: 12 })
    expect(parseVersionRange("20-", CURRENT)).toEqual({ from: 20, to: 30 })
  })

  it("reads the whole history", () => {
    expect(parseVersionRange("all", CURRENT)).toEqual({ from: 1, to: 30 })
    expect(parseVersionRange("ALL", CURRENT)).toEqual({ from: 1, to: 30 })
    expect(parseVersionRange("*", CURRENT)).toEqual({ from: 1, to: 30 })
  })

  it("clamps a range that runs past the current version", () => {
    // Asking for more history than exists is a reasonable thing to do, not an error.
    expect(parseVersionRange("1-999", CURRENT)).toEqual({ from: 1, to: 30 })
  })

  it("tolerates stray quotes and whitespace, like the lines grammar", () => {
    expect(parseVersionRange(' "1-30" ', CURRENT)).toEqual({ from: 1, to: 30 })
    expect(parseVersionRange("  all  ", CURRENT)).toEqual({ from: 1, to: 30 })
  })

  it("rejects what it cannot honestly answer", () => {
    expect(parseVersionRange("5-2", CURRENT)).toBeNull() // inverted
    expect(parseVersionRange("0", CURRENT)).toBeNull() // versions are 1-indexed
    expect(parseVersionRange("99", CURRENT)).toBeNull() // start past the end
    expect(parseVersionRange("nope", CURRENT)).toBeNull()
    expect(parseVersionRange("", CURRENT)).toBeNull()
    expect(parseVersionRange("1..5", CURRENT)).toBeNull()
    expect(parseVersionRange("-5", CURRENT)).toBeNull()
  })

  it("handles a one-version artifact", () => {
    expect(parseVersionRange("all", 1)).toEqual({ from: 1, to: 1 })
    expect(parseVersionRange("1", 1)).toEqual({ from: 1, to: 1 })
    expect(parseVersionRange("2", 1)).toBeNull()
  })
})
