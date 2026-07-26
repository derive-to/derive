import { describe, expect, it } from "vitest"
import { parseAnchor } from "./types"

describe("parseAnchor", () => {
  it("returns null for null, invalid JSON, or a missing exact", () => {
    expect(parseAnchor(null)).toBeNull()
    expect(parseAnchor("{not json")).toBeNull()
    expect(parseAnchor(JSON.stringify({ prefix: "x" }))).toBeNull()
  })

  it("extracts the exact quote (with optional prefix/suffix)", () => {
    const a = JSON.stringify({ exact: "hello", prefix: "say ", suffix: "!" })
    expect(parseAnchor(a)).toEqual({ exact: "hello", prefix: "say ", suffix: "!" })
  })

  it("parses an element anchor into { element, label, slide }", () => {
    const a = JSON.stringify({
      type: "ElementSelector",
      tag: "img",
      fingerprint: "abc",
      slide: 2,
      snapshot: { tag: "img", label: "Image — chart.png" },
    })
    const p = parseAnchor(a)
    expect(p?.element?.tag).toBe("img")
    expect(p?.label).toBe("Image — chart.png")
    expect(p?.slide).toBe(2)
    expect(p?.exact).toBeUndefined()
  })

  it("falls back to 'Element' when an element anchor has no snapshot label", () => {
    const a = JSON.stringify({ type: "ElementSelector", tag: "table", fingerprint: "z" })
    expect(parseAnchor(a)?.label).toBe("Element")
  })

  it("an ElementSelector missing tag/fingerprint is not treated as an element anchor", () => {
    // No exact and not a valid element → null.
    expect(parseAnchor(JSON.stringify({ type: "ElementSelector", tag: "img" }))).toBeNull()
  })
})
