import { describe, expect, it } from "vitest"
import { splitMatches } from "./highlight"

describe("splitMatches", () => {
  it("marks case-insensitive literal matches, preserving original casing + surrounding text", () => {
    expect(splitMatches("the Kestrel and the kestrel", "kestrel")).toEqual([
      { text: "the ", match: false },
      { text: "Kestrel", match: true },
      { text: " and the ", match: false },
      { text: "kestrel", match: true },
    ])
  })

  it("returns the whole text unmarked when the query is empty or unmatched", () => {
    expect(splitMatches("hello world", "")).toEqual([{ text: "hello world", match: false }])
    expect(splitMatches("hello world", "   ")).toEqual([{ text: "hello world", match: false }])
    expect(splitMatches("hello world", "xyz")).toEqual([{ text: "hello world", match: false }])
  })

  it("handles a match at the very start and the very end", () => {
    expect(splitMatches("foobar", "foo")).toEqual([
      { text: "foo", match: true },
      { text: "bar", match: false },
    ])
    expect(splitMatches("barfoo", "foo")).toEqual([
      { text: "bar", match: false },
      { text: "foo", match: true },
    ])
  })
})
