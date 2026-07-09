import { describe, expect, it } from "vitest"
import { accessIcon, accessSummary } from "./share-dialog"

// The share dialog's pure access projections. The invariant under test: a
// workspace-open collection makes an artifact workspace-reachable regardless of the
// artifact's own fields (see access-model.md), so the trigger glyph and the read-only
// summary must both fold that grant in — the lock is a promise ("nobody but the
// roster"), never shown when a collection breaks it. (Which collections count as
// granting is the SERVER's contract — covered in collection-access.test.ts.)

describe("accessIcon", () => {
  it("world link wins: globe even when a collection is also open", () => {
    expect(accessIcon("viewer", "none", true)).toBe("globe")
  })
  it("workspace seat access shows the share glyph", () => {
    expect(accessIcon("none", "member", false)).toBe("share")
  })
  it("invite-only with NO collection grant keeps the lock", () => {
    expect(accessIcon("none", "none", false)).toBe("lock")
  })
  it("a workspace-open collection breaks the lock's promise — share glyph instead", () => {
    expect(accessIcon("none", "none", true)).toBe("share")
  })
})

describe("accessSummary", () => {
  it("folds a workspace-open collection into the workspace summary", () => {
    expect(accessSummary("none", "none", true)).toBe("Everyone in the workspace can open this.")
  })
  it("stays invite-only without a collection grant", () => {
    expect(accessSummary("none", "none", false)).toBe("Only invited people can open this.")
  })
  it("the world link outranks everything", () => {
    expect(accessSummary("editor", "none", true)).toBe("Anyone with the link can edit.")
  })
})
