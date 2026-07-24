import { describe, expect, it } from "vitest"
import { canCommentWithRole } from "./comment-access"

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
