import { describe, expect, it } from "vitest"
import type { Comment } from "@/api"
import { anchorExact, anchorLabel, clamp, groupThreads, layoutPins, parseAnchor } from "./layout"

describe("clamp", () => {
  it("bounds a value to [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
})

describe("layoutPins", () => {
  const heights = { a: 100, b: 100 }

  it("stacks overlapping cards apart by the gap, top-down", () => {
    const pos = layoutPins(
      [
        { id: "a", desiredY: 0 },
        { id: "b", desiredY: 10 },
      ],
      heights,
      null,
      8,
    )
    expect(pos.a).toBe(0)
    // b wanted 10 but a occupies 0..100, so b is pushed to 100 + gap.
    expect(pos.b).toBe(108)
  })

  it("pins the active card to its exact Y and pushes a neighbour above out of the way", () => {
    const pos = layoutPins(
      [
        { id: "a", desiredY: 0 },
        { id: "b", desiredY: 10 },
      ],
      heights,
      "b",
      8,
    )
    expect(pos.b).toBe(10) // pinned to its desired Y
    expect(pos.a).toBe(-98) // pushed up: 10 - 8(gap) - 100(height)
  })

  it("pins the active first card and flows the rest below it", () => {
    const pos = layoutPins(
      [
        { id: "a", desiredY: 0 },
        { id: "b", desiredY: 50 },
      ],
      heights,
      "a", // active is first in sort order, so the below-neighbour pass runs
      8,
    )
    expect(pos.a).toBe(0) // pinned to its desired Y
    expect(pos.b).toBe(108) // below a (0..100) + gap
  })
})

describe("parseAnchor / anchorExact", () => {
  it("returns null for null, invalid JSON, or a missing exact", () => {
    expect(parseAnchor(null)).toBeNull()
    expect(parseAnchor("{not json")).toBeNull()
    expect(parseAnchor(JSON.stringify({ prefix: "x" }))).toBeNull()
    expect(anchorExact(null)).toBeNull()
  })

  it("extracts the exact quote (with optional prefix/suffix)", () => {
    const a = JSON.stringify({ exact: "hello", prefix: "say ", suffix: "!" })
    expect(parseAnchor(a)).toEqual({ exact: "hello", prefix: "say ", suffix: "!" })
    expect(anchorExact(a)).toBe("hello")
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
    // anchorExact is text-only → null for an element; anchorLabel returns the label.
    expect(anchorExact(a)).toBeNull()
    expect(anchorLabel(a)).toBe("Image — chart.png")
  })

  it("falls back to 'Element' when an element anchor has no snapshot label", () => {
    const a = JSON.stringify({ type: "ElementSelector", tag: "table", fingerprint: "z" })
    expect(parseAnchor(a)?.label).toBe("Element")
  })

  it("an ElementSelector missing tag/fingerprint is not treated as an element anchor", () => {
    // No exact and not a valid element → null.
    expect(parseAnchor(JSON.stringify({ type: "ElementSelector", tag: "img" }))).toBeNull()
  })

  it("anchorLabel returns the quote for text, the label for elements, null otherwise", () => {
    expect(anchorLabel(JSON.stringify({ exact: "hi" }))).toBe("hi")
    expect(anchorLabel(null)).toBeNull()
  })
})

describe("groupThreads", () => {
  it("buckets comments by thread_id, preserving order", () => {
    const c = (id: string, thread_id: string) => ({ id, thread_id }) as unknown as Comment
    const groups = groupThreads([c("1", "t1"), c("2", "t2"), c("3", "t1")])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.map((x) => x.id)).toEqual(["1", "3"])
    expect(groups[1]?.map((x) => x.id)).toEqual(["2"])
  })
})
