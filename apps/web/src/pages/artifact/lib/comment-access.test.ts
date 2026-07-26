import { describe, expect, it } from "vitest"
import { canCommentWithRole, commentNudgeCopy, shouldPromptSignInToComment } from "./comment-access"

// The UI side of the access matrix (the API is the hard gate; these decide which
// affordances render). Mirrors SECURITY.md and the core permissions matrix.
describe("canCommentWithRole (write-affordance gate)", () => {
  it("commenter and above may comment; viewer / no-access may not", () => {
    expect(canCommentWithRole("owner")).toBe(true)
    expect(canCommentWithRole("editor")).toBe(true)
    expect(canCommentWithRole("commenter")).toBe(true)
    expect(canCommentWithRole("viewer")).toBe(false)
    expect(canCommentWithRole(null)).toBe(false)
    expect(canCommentWithRole(undefined)).toBe(false)
  })
})

describe("shouldPromptSignInToComment (anonymous CTA)", () => {
  it("offers sign-in only on a live comment-enabled link", () => {
    expect(shouldPromptSignInToComment("commenter", false)).toBe(true)
    expect(shouldPromptSignInToComment("editor", false)).toBe(true)
  })
  it("stays hidden when signing in wouldn't unlock commenting, or when removed", () => {
    expect(shouldPromptSignInToComment("viewer", false)).toBe(false) // view-only link
    expect(shouldPromptSignInToComment(undefined, false)).toBe(false) // no general access
    expect(shouldPromptSignInToComment("commenter", true)).toBe(false) // tombstoned
  })
})

describe("commentNudgeCopy (pill + panel wording)", () => {
  it("with open threads: the pill counts them, the panel invites joining", () => {
    expect(commentNudgeCopy(9)).toEqual({
      pill: "9 comments",
      heading: "9 comments",
      cta: "Sign in to join",
    })
    expect(commentNudgeCopy(1)).toEqual({
      pill: "1 comment",
      heading: "1 comment",
      cta: "Sign in to join",
    })
  })
  it("with none (or an absent count): a plain invitation to start", () => {
    const empty = { pill: "Comments", heading: "No comments yet", cta: "Sign in to comment" }
    expect(commentNudgeCopy(0)).toEqual(empty)
    expect(commentNudgeCopy(undefined)).toEqual(empty)
  })
})
