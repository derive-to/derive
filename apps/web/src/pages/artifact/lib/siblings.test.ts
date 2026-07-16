import { describe, expect, it } from "vitest"
import { resolveContextCollection, siblingNav } from "./siblings"

describe("resolveContextCollection", () => {
  it("uses the ?collection param when the artifact is actually in it", () => {
    expect(resolveContextCollection("c1", ["c1", "c2"])).toBe("c1")
  })
  it("ignores a stale param the artifact is NOT in, falling through", () => {
    // param points at a collection the artifact left → fall back to its sole collection
    expect(resolveContextCollection("gone", ["c2"])).toBe("c2")
    // …or to nothing when it's ambiguous
    expect(resolveContextCollection("gone", ["c2", "c3"])).toBeNull()
  })
  it("falls back to the sole collection when there's no valid param", () => {
    expect(resolveContextCollection(undefined, ["only"])).toBe("only")
  })
  it("returns null when the artifact is in zero or many collections and no param picks one", () => {
    expect(resolveContextCollection(undefined, [])).toBeNull()
    expect(resolveContextCollection(undefined, ["a", "b"])).toBeNull()
    expect(resolveContextCollection(undefined, undefined)).toBeNull()
  })
})

describe("siblingNav", () => {
  const ids = ["a", "b", "c"]
  it("reports position and clamps prev/next at the ends (no wrap)", () => {
    expect(siblingNav(ids, "a")).toEqual({ index: 0, total: 3, prev: null, next: "b" })
    expect(siblingNav(ids, "b")).toEqual({ index: 1, total: 3, prev: "a", next: "c" })
    expect(siblingNav(ids, "c")).toEqual({ index: 2, total: 3, prev: "b", next: null })
  })
  it("handles a current id missing from the list (no prev/next)", () => {
    expect(siblingNav(ids, "x")).toEqual({ index: -1, total: 3, prev: null, next: null })
  })
  it("handles a single-item list", () => {
    expect(siblingNav(["solo"], "solo")).toEqual({ index: 0, total: 1, prev: null, next: null })
  })
})
