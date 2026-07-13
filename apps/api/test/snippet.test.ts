import { describe, expect, it } from "vitest"
import { snippetAround } from "../src/lib/search"

// snippetAround windows a matching line so the highlighted term survives the palette's
// single-line, LEFT-truncating render — the match must land near the left edge.
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
})
