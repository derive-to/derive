import { describe, expect, it } from "vitest"
import { type Actor, can, effectiveRole, roleAllows } from "../src/permissions"

describe("roleAllows", () => {
  it("editors publish + approve but only owners manage", () => {
    expect(roleAllows("editor", "publish")).toBe(true)
    expect(roleAllows("editor", "approve")).toBe(true)
    expect(roleAllows("editor", "manage")).toBe(false)
    expect(roleAllows("owner", "manage")).toBe(true)
  })
  it("commenters comment + read but cannot publish or approve", () => {
    expect(roleAllows("commenter", "comment")).toBe(true)
    expect(roleAllows("commenter", "read")).toBe(true)
    expect(roleAllows("commenter", "publish")).toBe(false)
    expect(roleAllows("commenter", "approve")).toBe(false)
  })
  it("a commenter proposes a candidate, but only an editor approves it", () => {
    expect(roleAllows("commenter", "propose")).toBe(true)
    expect(roleAllows("commenter", "approve")).toBe(false)
    expect(roleAllows("viewer", "propose")).toBe(false)
    expect(roleAllows("editor", "propose")).toBe(true)
    expect(roleAllows("editor", "approve")).toBe(true)
  })
  it("viewers only read", () => {
    expect(roleAllows("viewer", "read")).toBe(true)
    expect(roleAllows("viewer", "comment")).toBe(false)
  })
})

describe("effectiveRole resolution", () => {
  const user = (over: Partial<Actor>): Actor => ({ kind: "user", userId: "u1", ...over })

  it("per-artifact share overrides the workspace role", () => {
    expect(effectiveRole(user({ orgRole: "viewer", artifactRole: "editor" }), "org")).toBe("editor")
    expect(effectiveRole(user({ orgRole: "editor", artifactRole: "viewer" }), "org")).toBe("viewer")
  })
  it("falls back to the workspace role when there's no share", () => {
    expect(effectiveRole(user({ orgRole: "commenter" }), "org")).toBe("commenter")
  })
  it("a non-member gets viewer on public/link, nothing on private", () => {
    expect(effectiveRole(user({}), "link")).toBe("viewer")
    expect(effectiveRole(user({}), "public")).toBe("viewer")
    expect(effectiveRole(user({}), "org")).toBe(null)
    expect(effectiveRole(user({}), "password")).toBe(null)
  })
  it("a static token is owner; an anonymous caller is always read-only", () => {
    expect(effectiveRole({ kind: "token" }, "org")).toBe("owner")
    // No "open"/trusted-anonymous path exists: anon never gets a writing role.
    expect(effectiveRole({ kind: "anon" }, "org")).toBe(null)
    expect(effectiveRole({ kind: "anon" }, "link")).toBe("viewer")
    expect(effectiveRole({ kind: "anon" }, "public")).toBe("viewer")
  })
})

describe("can", () => {
  it("an editor publishes, a commenter cannot", () => {
    expect(can({ kind: "user", artifactRole: "editor" }, "publish", "org")).toBe(true)
    expect(can({ kind: "user", artifactRole: "commenter" }, "publish", "org")).toBe(false)
    expect(can({ kind: "user", artifactRole: "commenter" }, "comment", "org")).toBe(true)
  })
  it("a link viewer reads but cannot comment", () => {
    expect(can({ kind: "anon" }, "read", "link")).toBe(true)
    expect(can({ kind: "anon" }, "comment", "link")).toBe(false)
  })
})

// The general-access (the link) comment grant, every cell of the access matrix. The
// invariant under test: an anonymous reacher is NEVER more than viewer; the comment grant
// only lifts a signed-in reacher to commenter. Mirrors the table in SECURITY.md.
describe("general access comment grant (access matrix)", () => {
  const anon: Actor = { kind: "anon" }
  // A signed-in caller reaching purely via the link, with no explicit share/membership.
  const reacher: Actor = { kind: "user", userId: "u9" }

  it("view link: everyone reaching is viewer, nobody can comment", () => {
    for (const v of ["link", "public"] as const) {
      expect(effectiveRole(anon, v, "viewer")).toBe("viewer")
      expect(effectiveRole(reacher, v, "viewer")).toBe("viewer")
      expect(can(anon, "comment", v, "viewer")).toBe(false)
      expect(can(reacher, "comment", v, "viewer")).toBe(false)
    }
  })

  it("comment link: anon stays viewer (forced auth), a signed-in reacher becomes commenter", () => {
    for (const v of ["link", "public"] as const) {
      expect(effectiveRole(anon, v, "commenter")).toBe("viewer")
      expect(can(anon, "comment", v, "commenter")).toBe(false) // anon never elevated
      expect(can(anon, "read", v, "commenter")).toBe(true)
      expect(effectiveRole(reacher, v, "commenter")).toBe("commenter")
      expect(can(reacher, "comment", v, "commenter")).toBe(true)
    }
  })

  it("the comment floor is a max with the explicit role, never a demotion", () => {
    // A viewer-member is lifted to commenter by a comment link...
    expect(effectiveRole({ kind: "user", orgRole: "viewer" }, "link", "commenter")).toBe(
      "commenter",
    )
    // ...but a higher explicit role is untouched.
    expect(effectiveRole({ kind: "user", orgRole: "editor" }, "link", "commenter")).toBe("editor")
    expect(effectiveRole({ kind: "user", artifactRole: "owner" }, "link", "commenter")).toBe(
      "owner",
    )
  })

  it("password: the comment grant follows unlock, and never elevates anon", () => {
    expect(effectiveRole(anon, "password", "commenter")).toBe(null) // locked
    expect(effectiveRole({ kind: "anon", unlocked: true }, "password", "commenter")).toBe("viewer")
    expect(can({ kind: "anon", unlocked: true }, "comment", "password", "commenter")).toBe(false)
    expect(
      effectiveRole({ kind: "user", userId: "u", unlocked: true }, "password", "commenter"),
    ).toBe("commenter")
  })

  it("workspace-only (org) grants nothing by reach, regardless of the comment grant", () => {
    expect(effectiveRole(anon, "org", "commenter")).toBe(null)
    expect(effectiveRole(reacher, "org", "commenter")).toBe(null)
  })

  it("defaults to view-only when no general role is given (back-compat)", () => {
    expect(effectiveRole(reacher, "link")).toBe("viewer")
    expect(can(reacher, "comment", "link")).toBe(false)
  })
})
