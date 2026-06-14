import { describe, expect, it } from "vitest"
import { parseRef } from "./parse-ref"

describe("parseRef", () => {
  it("reads a bare short id", () => {
    expect(parseRef("abc123")).toEqual({ shortId: "abc123", version: undefined })
  })

  it("ignores a trailing slug", () => {
    expect(parseRef("abc123-my-title")).toEqual({ shortId: "abc123", version: undefined })
    expect(parseRef("abc123-a-longer-slug-here")).toMatchObject({ shortId: "abc123" })
  })

  it("parses an @vN version suffix", () => {
    expect(parseRef("abc123@v4")).toEqual({ shortId: "abc123", version: 4 })
    expect(parseRef("abc123-my-title@v2")).toEqual({ shortId: "abc123", version: 2 })
  })

  it("falls back to the raw ref when it doesn't match the shape", () => {
    // Too short / wrong charset → no capture, so the whole ref is the id.
    expect(parseRef("X")).toEqual({ shortId: "X", version: undefined })
    expect(parseRef("ABC123")).toEqual({ shortId: "ABC123", version: undefined })
  })
})
