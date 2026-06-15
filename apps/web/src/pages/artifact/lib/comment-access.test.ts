import { describe, expect, it } from "vitest"
import { canCommentWithRole, shouldPromptSignInToComment } from "./comment-access"

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
  it("offers sign-in only to an anon visitor on a live comment-enabled link", () => {
    expect(shouldPromptSignInToComment(true, "commenter", false)).toBe(true)
  })
  it("stays hidden when signing in wouldn't help, when signed in, or when removed", () => {
    expect(shouldPromptSignInToComment(true, "viewer", false)).toBe(false) // view-only link
    expect(shouldPromptSignInToComment(true, undefined, false)).toBe(false) // no general access
    expect(shouldPromptSignInToComment(false, "commenter", false)).toBe(false) // already signed in
    expect(shouldPromptSignInToComment(true, "commenter", true)).toBe(false) // tombstoned
  })
})
