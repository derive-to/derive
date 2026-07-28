import { describe, expect, it } from "vitest"
import { nextPersonalBrandprint } from "./personal-brandprint"

// The account-scope save merge: never drop a field the caller isn't changing;
// collapse to null only when nothing is left worth saving.
describe("nextPersonalBrandprint", () => {
  it("sets a collection on a previously empty Brandprint", () => {
    expect(nextPersonalBrandprint(null, { collectionId: "col_1" })).toEqual({
      collectionId: "col_1",
    })
  })

  it("clears to null when clearing the collection leaves nothing else set", () => {
    expect(nextPersonalBrandprint({ collectionId: "col_1" }, { collectionId: undefined })).toBe(
      null,
    )
    expect(nextPersonalBrandprint(null, { collectionId: undefined })).toBe(null)
  })

  it("preserves the workspace toggle when only the collection changes", () => {
    expect(
      nextPersonalBrandprint(
        { collectionId: "col_1", useWorkspaceBrandprint: false },
        { collectionId: "col_2" },
      ),
    ).toEqual({ collectionId: "col_2", useWorkspaceBrandprint: false })
  })

  it("clearing the collection keeps an explicit toggle instead of collapsing to null", () => {
    expect(
      nextPersonalBrandprint(
        { collectionId: "col_1", useWorkspaceBrandprint: false },
        { collectionId: undefined },
      ),
    ).toEqual({ useWorkspaceBrandprint: false })
  })

  it("preserves the collection when only the toggle changes", () => {
    expect(
      nextPersonalBrandprint({ collectionId: "col_1" }, { useWorkspaceBrandprint: false }),
    ).toEqual({ collectionId: "col_1", useWorkspaceBrandprint: false })
  })

  it("turning the toggle back on writes undefined, not true", () => {
    const next = nextPersonalBrandprint(
      { collectionId: "col_1", useWorkspaceBrandprint: false },
      { useWorkspaceBrandprint: undefined },
    )
    expect(next).toEqual({ collectionId: "col_1" })
    expect(next?.useWorkspaceBrandprint).toBeUndefined()
  })

  it("turning the toggle off with nothing else set still saves (not null)", () => {
    expect(nextPersonalBrandprint(null, { useWorkspaceBrandprint: false })).toEqual({
      useWorkspaceBrandprint: false,
    })
  })

  it("turning the toggle on with nothing else set collapses to null", () => {
    expect(
      nextPersonalBrandprint(
        { useWorkspaceBrandprint: false },
        { useWorkspaceBrandprint: undefined },
      ),
    ).toBe(null)
  })
})
