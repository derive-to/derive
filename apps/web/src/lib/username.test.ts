import { describe, expect, it } from "vitest"
import {
  normalizeUsername,
  suggestUsername,
  USERNAME_MAX,
  USERNAME_MIN,
  usernameError,
} from "./username"

describe("normalizeUsername", () => {
  it("trims and lowercases", () => {
    expect(normalizeUsername("  Alice  ")).toBe("alice")
    expect(normalizeUsername("BoB")).toBe("bob")
  })
})

describe("usernameError", () => {
  it("accepts well-formed usernames (returns null)", () => {
    for (const ok of ["ab", "alice", "a-b", "a_b", "user123", "a1", "ALICE"])
      expect(usernameError(ok), ok).toBeNull()
  })

  it("rejects too short / too long with the length checked first", () => {
    expect(usernameError("a")).toMatch(/at least 2/)
    expect(usernameError("")).toMatch(/at least 2/)
    expect(usernameError("a".repeat(USERNAME_MAX + 1))).toMatch(/30 characters or fewer/)
    // "a" is also reserved, but the length message wins (length is checked first).
    expect(usernameError("a")).not.toMatch(/reserved/)
  })

  it("rejects bad shape: leading/trailing or doubled separators, and stray chars", () => {
    for (const bad of ["-ab", "ab-", "_ab", "ab_", "a--b", "a__b", "a b", "a.b", "ab!"])
      expect(usernameError(bad), bad).toMatch(/letters, numbers/)
  })

  it("rejects reserved names (after normalization)", () => {
    for (const r of ["admin", "dock", "ME", "Settings", "api"])
      expect(usernameError(r), r).toMatch(/reserved/)
  })
})

describe("suggestUsername", () => {
  it("derives from a display name", () => {
    expect(suggestUsername("Alice Smith")).toBe("alice-smith")
    expect(suggestUsername("Bob")).toBe("bob")
  })

  it("derives from an email local-part", () => {
    expect(suggestUsername("john.doe@example.com")).toBe("john-doe")
  })

  it("never collapses an all-punctuation / empty input to a reserved word", () => {
    expect(suggestUsername("!!!")).toBe("newuser") // not "user"
    expect(suggestUsername("@example.com")).toBe("newuser") // empty local-part
  })

  it("pads a too-short stem past the minimum", () => {
    expect(suggestUsername("a")).toBe("auser")
    expect(suggestUsername("x@y.com")).toBe("xuser")
    expect(suggestUsername("a").length).toBeGreaterThanOrEqual(USERNAME_MIN)
  })

  it("caps the suggestion at the maximum length with no trailing separator", () => {
    const long = suggestUsername("a".repeat(50))
    expect(long.length).toBeLessThanOrEqual(USERNAME_MAX)
    expect(long.endsWith("-")).toBe(false)
    expect(long.endsWith("_")).toBe(false)
  })
})
