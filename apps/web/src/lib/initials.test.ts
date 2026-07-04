import { describe, expect, it } from "vitest"
import { getInitials } from "./initials"

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
