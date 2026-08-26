import { describe, expect, it } from "vitest"
import { accessIcon, accessSummary, linkReachNote } from "@/components/shared/share-dialog-sections"

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
})

// The copy affordance's own projection. accessSummary answers "who can open this
// artifact"; this answers the different and more urgent question "what does the URL
// I just put on the clipboard do for the person I'm about to paste it to". They
// diverge exactly where shares silently fail: a workspace-open artifact reads as
// open in the summary, while its link is INERT for the outsider being emailed it.
describe("linkReachNote", () => {
  it("says nothing when the link itself opens for anyone, unaided", () => {
    expect(linkReachNote("viewer", "member")).toBeNull()
    expect(linkReachNote("commenter", "none")).toBeNull()
  })
  it("names the password on a world link that carries one", () => {
    expect(linkReachNote("viewer", "none", { locked: true })).toBe("They'll need the password too.")
  })
  it("names the workspace limit on a link that only members can open", () => {
    expect(linkReachNote("none", "member")).toBe("Only workspace members can open it.")
  })
  it("names the roster limit on an invite-only artifact", () => {
    expect(linkReachNote("none", "none")).toBe("Only the people you add can open it.")
  })
  it("folds a workspace-open collection in, like the sibling projections", () => {
    expect(linkReachNote("none", "none", { collectionOpen: true })).toBe(
      "Only workspace members can open it.",
    )
  })
  // The access section above the button already says "and anyone with access through a
  // collection" in this state; the footer must not contradict it four inches below.
  it("does not claim invite-only while a collection also reaches the artifact", () => {
    expect(linkReachNote("none", "none", { collectionShared: true })).toBe(
      "Only people you add, or who reach it via a collection.",
    )
  })
})
