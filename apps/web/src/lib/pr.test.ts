import { describe, expect, it } from "vitest"
import { prTitle, prUrl } from "./pr"

describe("prTitle", () => {
  it("strips the 'PR #<n>: ' prefix the sync engine adds", () => {
    expect(prTitle("PR #42: Add the feature", 42)).toBe("Add the feature")
    expect(prTitle("PR #5: Fix bug", 5)).toBe("Fix bug")
  })

  it("trims surrounding whitespace from the stripped title", () => {
    expect(prTitle("PR #12:   Spacey title  ", 12)).toBe("Spacey title")
  })

  it("returns the raw title when there's no PR number", () => {
    expect(prTitle("A manual collection")).toBe("A manual collection")
  })

  it("falls back to the raw title when it doesn't match the prefix shape", () => {
    expect(prTitle("Renamed without prefix", 7)).toBe("Renamed without prefix")
    // Degenerate empty title keeps its raw value rather than collapsing to "".
    expect(prTitle("PR #9: ", 9)).toBe("PR #9: ")
  })
})

describe("prUrl", () => {
  it("builds the GitHub pull-request URL from owner/name + number", () => {
    expect(prUrl("Niftory/dock.build", 42)).toBe("https://github.com/Niftory/dock.build/pull/42")
  })
})
