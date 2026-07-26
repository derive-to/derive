import { describe, expect, it } from "vitest"
import { generateUsername, normalizeUsername, suggestUsername, usernameError } from "./username"

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
    expect(suggestUsername("nia@derive.test")).toBe("nia")
    // Result is always itself a valid handle.
    for (const seed of ["Jane Doe", "a", "!!!", "x".repeat(50), "weird..name"])
      expect(usernameError(suggestUsername(seed))).toBeNull()
  })
})

describe("generateUsername", () => {
  const free = async () => false
  it("uses the clean base from the seed when available", async () => {
    expect(await generateUsername("ada@example.com", free)).toBe("ada")
  })
  it("appends a number when the base is taken", async () => {
    const used = new Set(["ada"])
    expect(await generateUsername("ada@example.com", async (u) => used.has(u))).toBe("ada2")
  })
  it("always returns a valid handle and never the email", async () => {
    for (const seed of ["ada@example.com", "Jane Doe", "!!!", ""]) {
      const u = await generateUsername(seed, free)
      expect(usernameError(u)).toBeNull()
      expect(u).not.toContain("@")
    }
  })
  it("never throws (and stays valid) when the availability check errors", async () => {
    const u = await generateUsername("ada@example.com", async () => {
      throw new Error("db down")
    })
    expect(usernameError(u)).toBeNull()
  })
  it("falls back to a unique-ish handle when every clean candidate is taken", async () => {
    const u = await generateUsername("ada@example.com", async () => true)
    expect(usernameError(u)).toBeNull()
  })
})
