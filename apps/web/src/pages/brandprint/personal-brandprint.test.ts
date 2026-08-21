import { describe, expect, it } from "vitest"
import { nextPersonalBrandprint } from "./personal-brandprint"

// The account-scope save merge: never drop a field the caller isn't changing;
// collapse to null only when nothing is left worth saving.
describe("nextPersonalBrandprint", () => {
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
})
