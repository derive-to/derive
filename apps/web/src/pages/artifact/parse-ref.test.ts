import { describe, expect, it } from "vitest"
import { candidateShortIds, parseRef, refFor } from "./parse-ref"

describe("parseRef", () => {
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

describe("refFor", () => {
  it("uses an explicit slug when present", () => {
    expect(refFor({ short_id: "abc123", slug: "my-doc", title: "Ignored" })).toBe("my-doc-abc123")
  })

  it("derives the name from the title when there's no slug", () => {
    expect(refFor({ short_id: "abc123", title: "Competitor Tracking" })).toBe(
      "competitor-tracking-abc123",
    )
    expect(refFor({ short_id: "abc123", slug: null, title: "Q3 2026 Report" })).toBe(
      "q3-2026-report-abc123",
    )
  })

  it("falls back to the bare short id when there's no name at all", () => {
    expect(refFor({ short_id: "abc123" })).toBe("abc123")
    expect(refFor({ short_id: "abc123", slug: null, title: null })).toBe("abc123")
    // A title that slugifies to empty also yields the bare id.
    expect(refFor({ short_id: "abc123", title: "!!!" })).toBe("abc123")
  })
})

describe("candidateShortIds", () => {
  it("takes the trailing token for a name-first ref", () => {
    expect(candidateShortIds("my-notes-zs1i7b42")).toEqual(["zs1i7b42"])
    // An id-looking chunk inside the name is ignored — the real id is the last token.
    expect(candidateShortIds("notes-123123-zs1i7b42")).toEqual(["zs1i7b42"])
  })

  it("offers the leading token for a legacy short-id-first ref", () => {
    expect(candidateShortIds("abc12345-my-title")).toEqual(["abc12345"])
    // Both ends id-shaped → try the trailing one first, then the leading (harmless:
    // a real short id is the trailing token and resolves first).
    expect(candidateShortIds("abc12345-deadbeef")).toEqual(["deadbeef", "abc12345"])
  })

  it("strips an @vN suffix and falls back to the whole base when nothing is id-shaped", () => {
    expect(candidateShortIds("my-notes-zs1i7b42@v3")).toEqual(["zs1i7b42"])
    expect(candidateShortIds("X")).toEqual(["X"])
  })
})
