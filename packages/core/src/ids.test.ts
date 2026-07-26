import { describe, expect, it } from "vitest"
import { candidateShortIds, newId, newShortId, parseRef, refFor, slugify } from "./ids"

describe("newShortId / newId — generated identifiers", () => {
  it("shape: a short id is 8 base36 chars; a prefixed id is <prefix>_<16>", () => {
    expect(newShortId()).toMatch(/^[0-9a-z]{8}$/)
    expect(newId("c")).toMatch(/^c_[0-9a-z]{16}$/)
    // Uniqueness is nanoid's contract; we only pin the format our code wraps it in.
  })
})

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics to single dashes, and trims them", () => {
    expect(slugify("  Hello, World!  ")).toBe("hello-world")
    expect(slugify("Q3 — Revenue (final)")).toBe("q3-revenue-final")
  })

  it("drops non-ascii and returns empty for all-symbol input", () => {
    expect(slugify("café")).toBe("caf") // non-ascii stripped
    expect(slugify("___")).toBe("")
    expect(slugify("")).toBe("")
  })

  it("caps the slug at 48 characters", () => {
    expect(slugify("a".repeat(60))).toHaveLength(48)
  })
})

describe("parseRef — /artifacts/:ref → { shortId, version }", () => {
  it("reads a bare short id and a name-first ref", () => {
    expect(parseRef("abc12345")).toEqual({ shortId: "abc12345", version: undefined })
    expect(parseRef("my-title-abc12345")).toEqual({ shortId: "abc12345", version: undefined })
  })

  it("parses the @vN version suffix", () => {
    expect(parseRef("my-title-abc12345@v4")).toEqual({ shortId: "abc12345", version: 4 })
  })

  it("falls back to the leading token for a legacy short-id-first ref", () => {
    // trailing "title" is too short to be id-shaped, so the leading id wins.
    expect(parseRef("abc12345-title")).toEqual({ shortId: "abc12345", version: undefined })
  })

  it("returns the whole base when no token is id-shaped", () => {
    expect(parseRef("hi")).toEqual({ shortId: "hi", version: undefined })
  })
})

describe("candidateShortIds — resolve-in-order for ambiguous refs", () => {
  it("offers the trailing token first, then the leading, de-duped", () => {
    expect(candidateShortIds("my-title-abc12345")).toEqual(["abc12345"])
    // Both tokens look like ids (a title whose tail is id-shaped): try trailing first.
    expect(candidateShortIds("abc12345-report99")).toEqual(["report99", "abc12345"])
    // A bare id resolves to a single candidate (not duplicated).
    expect(candidateShortIds("abc12345")).toEqual(["abc12345"])
  })

  it("falls back to the whole base when neither token is id-shaped", () => {
    expect(candidateShortIds("hi")).toEqual(["hi"])
  })
})

describe("refFor — build a readable /artifacts/:ref", () => {
  it("prefers an explicit slug, else slugifies the title, else bare short id", () => {
    expect(refFor({ short_id: "abc12345", slug: "my-doc" })).toBe("my-doc-abc12345")
    expect(refFor({ short_id: "abc12345", title: "My Doc!" })).toBe("my-doc-abc12345")
    expect(refFor({ short_id: "abc12345" })).toBe("abc12345")
    // slug wins over title.
    expect(refFor({ short_id: "abc12345", slug: "chosen", title: "Ignored" })).toBe(
      "chosen-abc12345",
    )
  })

  it("round-trips: a built ref parses back to the same short id", () => {
    const short = newShortId()
    const ref = refFor({ short_id: short, title: "Quarterly Revenue Review" })
    expect(parseRef(ref).shortId).toBe(short)
    expect(candidateShortIds(ref)).toContain(short)
  })
})
