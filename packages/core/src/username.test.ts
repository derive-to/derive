import { describe, expect, it } from "vitest"
import { normalizeUsername, suggestUsername, usernameError } from "./username"

describe("usernameError", () => {
  it("accepts well-formed handles", () => {
    for (const u of ["nia", "ab", "a1", "jane-doe", "jane_doe", "x".repeat(30)])
      expect(usernameError(u)).toBeNull()
  })

  it("rejects bad shapes with a reason", () => {
    expect(usernameError("a")).toMatch(/at least/i) // too short
    expect(usernameError("x".repeat(31))).toMatch(/fewer|characters/i) // too long
    expect(usernameError("has space")).toBeTruthy()
    expect(usernameError("-lead")).toBeTruthy() // leading separator
    expect(usernameError("trail-")).toBeTruthy() // trailing separator
    expect(usernameError("dou--ble")).toBeTruthy() // doubled separator
    expect(usernameError("oh.dot")).toBeTruthy() // illegal char
  })

  it("rejects reserved words (case-insensitively)", () => {
    expect(usernameError("settings")).toMatch(/reserved/i)
    expect(usernameError("ADMIN")).toMatch(/reserved/i)
    expect(usernameError("api")).toMatch(/reserved/i)
  })
})

describe("normalizeUsername", () => {
  it("trims and lowercases", () => {
    expect(normalizeUsername("  NiaSmith ")).toBe("niasmith")
  })
})

describe("suggestUsername", () => {
  it("derives a legal handle from a name or email", () => {
    expect(suggestUsername("Jane Doe")).toBe("jane-doe")
    expect(suggestUsername("nia@dock.test")).toBe("nia")
    // Result is always itself a valid handle.
    for (const seed of ["Jane Doe", "a", "!!!", "x".repeat(50), "weird..name"])
      expect(usernameError(suggestUsername(seed))).toBeNull()
  })
})
