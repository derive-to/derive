import { describe, expect, it } from "vitest"
import { getInitials, getMonogram } from "./initials"

describe("getInitials", () => {
  it("takes the first two characters, uppercased", () => {
    expect(getInitials("Alice")).toBe("AL")
    expect(getInitials("bob")).toBe("BO")
  })
  it("handles a single character", () => {
    expect(getInitials("x")).toBe("X")
  })
  it("trims surrounding whitespace first", () => {
    expect(getInitials("  ab")).toBe("AB")
  })
  it("falls back for empty / null / undefined", () => {
    expect(getInitials("")).toBe("?")
    expect(getInitials(null)).toBe("?")
    expect(getInitials(undefined)).toBe("?")
  })
  it("uses a caller-supplied fallback", () => {
    expect(getInitials("", "??")).toBe("??")
  })
})

describe("getMonogram", () => {
  it("takes the first character only, uppercased (a chrome-sized tile fits one glyph)", () => {
    expect(getMonogram("Homepage")).toBe("H")
    expect(getMonogram("brandprint")).toBe("B")
  })
  it("trims surrounding whitespace first", () => {
    expect(getMonogram("  pricing")).toBe("P")
  })
  it("keeps a leading digit or symbol as-is", () => {
    expect(getMonogram("2024 launch")).toBe("2")
  })
  it("keeps a leading emoji whole (no split surrogate pair)", () => {
    expect(getMonogram("🚀 Launch")).toBe("🚀")
  })
  it("falls back for empty / null / undefined", () => {
    expect(getMonogram("")).toBe("?")
    expect(getMonogram(null)).toBe("?")
    expect(getMonogram(undefined)).toBe("?")
  })
})
