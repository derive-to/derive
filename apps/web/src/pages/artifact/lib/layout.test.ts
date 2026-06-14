import { describe, expect, it } from "vitest"
import type { Comment } from "@/api"
import { anchorExact, clamp, groupThreads, layoutPins, parseAnchor } from "./layout"

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
})

describe("groupThreads", () => {
  it("buckets comments by thread_id, preserving order", () => {
    const c = (id: string, thread_id: string) => ({ id, thread_id }) as unknown as Comment
    const groups = groupThreads([c("1", "t1"), c("2", "t2"), c("3", "t1")])
    expect(groups).toHaveLength(2)
    expect(groups[0].map((x) => x.id)).toEqual(["1", "3"])
    expect(groups[1].map((x) => x.id)).toEqual(["2"])
  })
})
