import { describe, expect, it } from "vitest"
import { searchMatcher, snippetAround, stripMarkup } from "../src/lib/search"

// snippetAround windows a matching line so the highlighted term survives the palette's
// single-line, LEFT-truncating render — the match must land near the left edge.
describe("searchMatcher", () => {
  it("matches the full query literally, including multi-word phrases", () => {
    const re = searchMatcher("alpha beta", false)
    expect(re.test("the alpha beta arrives")).toBe(true)
    // Token overlap alone is not enough — that is FTS recall; grep stays precise.
    expect(re.test("the alpha arrives")).toBe(false)
    expect(re.test("only beta here")).toBe(false)
  })

  it("keeps hyphenated needles whole (does not OR the parts)", () => {
    const re = searchMatcher("visible-rest-needle-1", false)
    expect(re.test("the visible-rest-needle-1 is here")).toBe(true)
    expect(re.test("visible rest needle 1")).toBe(false)
    expect(re.test("just visible and needle")).toBe(false)
  })

  it("escapes metacharacters so pasted literals stay safe", () => {
    const re = searchMatcher("a.b()", false)
    expect(re.test("call a.b() now")).toBe(true)
    expect(re.test("call axb) now")).toBe(false)
  })
})

describe("stripMarkup", () => {
  it("drops tags so a semantic snippet does not leak raw HTML into ⌘K", () => {
    expect(stripMarkup("<p>Hello <strong>world</strong></p>")).toBe("Hello world")
    expect(stripMarkup("<div class='x'>deck&nbsp;title</div>")).toContain("deck")
  })
})

describe("snippetAround", () => {
  it("returns a short line whole, with the match intact", () => {
    expect(snippetAround("the kestrel review is friday", "kestrel")).toBe(
      "the kestrel review is friday",
    )
  })

  it("windows a long line so the match sits near the LEFT edge (not centered off-screen)", () => {
    const line = `${"x".repeat(120)}kestrel${"y".repeat(120)}`
    const snip = snippetAround(line, "kestrel")
    expect(snip.startsWith("…")).toBe(true) // leading context elided
    expect(snip).toContain("kestrel")
    // The match is near the start of the returned snippet, so left-truncation keeps it.
    expect(snip.indexOf("kestrel")).toBeLessThan(20)
    expect(snip.length).toBeLessThanOrEqual(161) // SNIPPET_LEN + the leading ellipsis
  })

  it("omits the leading ellipsis when the match is at the start", () => {
    const snip = snippetAround(`kestrel${"y".repeat(300)}`, "kestrel")
    expect(snip.startsWith("kestrel")).toBe(true)
    expect(snip.endsWith("…")).toBe(true) // trailing context elided
  })

  it("omits the trailing ellipsis when the match is at the end", () => {
    const snip = snippetAround(`${"x".repeat(300)}kestrel`, "kestrel")
    expect(snip.startsWith("…")).toBe(true)
    expect(snip.endsWith("kestrel")).toBe(true)
  })

  it("collapses whitespace in BOTH the line and a multi-space query so the match is found", () => {
    // Deeply-indented / multi-spaced source line, and a query with stray spaces.
    const line = `${"z".repeat(120)}the   alpha    beta${"z".repeat(120)}`
    const snip = snippetAround(line, "alpha  beta")
    expect(snip).toContain("alpha beta") // collapsed + located (not the not-found fallback)
    expect(snip.indexOf("alpha beta")).toBeLessThan(30)
  })

  it("falls back to the head of the line when the literal isn't present", () => {
    expect(snippetAround("a short line with no hit", "zzz")).toBe("a short line with no hit")
    const long = snippetAround("q".repeat(300), "zzz")
    expect(long.endsWith("…")).toBe(true)
    expect(long.length).toBeLessThanOrEqual(161)
  })

  it("windows on the first token when only one word of a multi-word query is present", () => {
    const line = `${"x".repeat(120)}beta-only line${"y".repeat(120)}`
    const snip = snippetAround(line, "alpha beta")
    expect(snip).toContain("beta")
    expect(snip.indexOf("beta")).toBeLessThan(30)
  })
})
