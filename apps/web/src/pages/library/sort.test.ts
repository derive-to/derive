import { describe, expect, it } from "vitest"
import { DEFAULT_SORT, LIBRARY_SORTS, parseLibrarySort, sortLabel } from "./sort"

describe("parseLibrarySort", () => {
  it("keeps a valid non-default mode and drops the default (stays out of the URL)", () => {
    expect(parseLibrarySort("az")).toBe("az")
    expect(parseLibrarySort("created")).toBe("created")
    expect(parseLibrarySort(DEFAULT_SORT)).toBeUndefined()
    expect(parseLibrarySort("bogus")).toBeUndefined()
    expect(parseLibrarySort(undefined)).toBeUndefined()
    expect(parseLibrarySort(123)).toBeUndefined()
  })

  it("drops modes the menu no longer offers, so a stale link falls back to the default", () => {
    // `revised` is still a valid API sort — it just isn't a menu option any more, and an
    // old bookmark carrying it must land on the default list rather than a mode the UI
    // cannot show as selected.
    for (const retired of ["revised", "revised-asc"]) {
      expect(parseLibrarySort(retired)).toBeUndefined()
    }
  })

  it("keeps the reversed directions the list header writes", () => {
    // Click-again-to-flip on a column header writes these. The parser used to strip
    // them, so reversing a sort silently snapped back to the default on the next parse.
    expect(parseLibrarySort("za")).toBe("za")
    expect(parseLibrarySort("updated-asc")).toBe("updated-asc")
    expect(sortLabel("za")).toBe("Title Z–A")
    expect(sortLabel("updated-asc")).toBe("Least recently active")
  })

  it("offers three modes, each naming what it orders by, default first", () => {
    expect(LIBRARY_SORTS.map((s) => s.value)).toEqual(["updated", "created", "az"])
    expect(LIBRARY_SORTS[0]).toEqual({ value: "updated", label: "Recently active" })
    expect(LIBRARY_SORTS.map((s) => s.label)).toEqual([
      "Recently active",
      "Recently created",
      "Title A–Z",
    ])
  })

  it("resolves a label, falling back for a mode the menu dropped", () => {
    expect(sortLabel("az")).toBe("Title A–Z")
    expect(sortLabel(DEFAULT_SORT)).toBe("Recently active")
    expect(sortLabel("revised")).toBe("Recently active")
  })
})
