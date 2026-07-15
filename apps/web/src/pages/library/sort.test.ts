import { describe, expect, it } from "vitest"
import { DEFAULT_SORT, LIBRARY_SORTS, parseLibrarySort, sortLabel } from "./sort"

describe("parseLibrarySort", () => {
  it("keeps a valid non-default mode and drops the default (stays out of the URL)", () => {
    expect(parseLibrarySort("az")).toBe("az")
    expect(parseLibrarySort("created-asc")).toBe("created-asc")
    expect(parseLibrarySort(DEFAULT_SORT)).toBeUndefined()
    expect(parseLibrarySort("bogus")).toBeUndefined()
    expect(parseLibrarySort(undefined)).toBeUndefined()
    expect(parseLibrarySort(123)).toBeUndefined()
  })

  it("offers all six modes with labels, default first, and resolves a mode's label", () => {
    expect(LIBRARY_SORTS.map((s) => s.value)).toEqual([
      "updated",
      "updated-asc",
      "created",
      "created-asc",
      "az",
      "za",
    ])
    expect(LIBRARY_SORTS[0]).toEqual({ value: "updated", label: "Recently updated" })
    expect(sortLabel("az")).toBe("Title A–Z")
    expect(sortLabel(DEFAULT_SORT)).toBe("Recently updated")
  })
})
