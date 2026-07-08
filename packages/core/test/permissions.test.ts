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
  it("a non-member gets nothing anywhere with no link grant, and never past viewer on a lock", () => {
    // Round 4: the link pair defaults to none/org (fail closed) — a bare reacher
    // needs an explicit public-audience grant, not an implicit `viewer`.
    expect(effectiveRole(user({}), "public")).toBe(null)
    expect(effectiveRole(user({}), "public", "viewer", "public")).toBe("viewer")
    expect(effectiveRole(user({}), "public", "viewer", "org")).toBe(null) // not a member
    expect(effectiveRole(user({}), "org")).toBe(null)
    expect(effectiveRole(user({ locked: true }), "public", "viewer", "public")).toBe(null)
  })
  it("a static token is owner; an anonymous caller is always read-only, never above viewer", () => {
    expect(effectiveRole({ kind: "token" }, "org")).toBe("owner")
    // No "open"/trusted-anonymous path exists: anon never gets a writing role,
    // even on an editor-grant public link — and never enters an org audience.
    expect(effectiveRole({ kind: "anon" }, "org")).toBe(null)
    expect(effectiveRole({ kind: "anon" }, "public", "viewer", "public")).toBe("viewer")
    expect(effectiveRole({ kind: "anon" }, "private", "editor", "public")).toBe("viewer")
    expect(effectiveRole({ kind: "anon" }, "private", "editor", "org")).toBe(null)
  })
})

describe("can", () => {
  it("an editor publishes, a commenter cannot", () => {
    expect(can({ kind: "user", artifactRole: "editor" }, "publish", "org")).toBe(true)
    expect(can({ kind: "user", artifactRole: "commenter" }, "publish", "org")).toBe(false)
    expect(can({ kind: "user", artifactRole: "commenter" }, "comment", "org")).toBe(true)
  })
  it("a public-audience viewer link reads but cannot comment", () => {
    expect(can({ kind: "anon" }, "read", "public", "viewer", "public")).toBe(true)
    expect(can({ kind: "anon" }, "comment", "public", "viewer", "public")).toBe(false)
  })
})

// The link grant (round 4: audience × capability, at ANY visibility), every cell
// of the access matrix. The invariants under test: an anonymous reacher is NEVER
// more than viewer and never enters an org audience; grants only lift signed-in
// holders the audience admits. Mirrors SECURITY.md and docs/plans/link-grant.md.
describe("the link grant (access matrix)", () => {
  const anon: Actor = { kind: "anon" }
  // A signed-in caller reaching purely via the link, with no explicit share/membership.
  const reacher: Actor = { kind: "user", userId: "u9" }
  // A signed-in member of the artifact's workspace (the org-audience key).
  const member: Actor = { kind: "user", userId: "u10", orgRole: "commenter" }

  it("public-audience view link: everyone reaching is viewer, nobody can comment", () => {
    expect(effectiveRole(anon, "public", "viewer", "public")).toBe("viewer")
    expect(effectiveRole(reacher, "public", "viewer", "public")).toBe("viewer")
    expect(can(anon, "comment", "public", "viewer", "public")).toBe(false)
    expect(can(reacher, "comment", "public", "viewer", "public")).toBe(false)
  })

  it("public-audience comment link: anon stays viewer (forced auth), signed-in becomes commenter", () => {
    expect(effectiveRole(anon, "public", "commenter", "public")).toBe("viewer")
    expect(can(anon, "comment", "public", "commenter", "public")).toBe(false) // anon never elevated
    expect(can(anon, "read", "public", "commenter", "public")).toBe(true)
    expect(effectiveRole(reacher, "public", "commenter", "public")).toBe("commenter")
    expect(can(reacher, "comment", "public", "commenter", "public")).toBe(true)
  })

  it("org-audience link: members in, outsiders and anon out — at any visibility", () => {
    // Private + workspace link (scenario 1): the member gets the grant...
    expect(effectiveRole(member, "private", "commenter", "org")).toBe("commenter")
    // ...an outsider and anon get nothing from the same URL.
    expect(effectiveRole(reacher, "private", "commenter", "org")).toBeNull()
    expect(effectiveRole(anon, "private", "commenter", "org")).toBeNull()
    // Org visibility: the org-audience floor is a no-op below the membership role.
    expect(effectiveRole(member, "org", "viewer", "org")).toBe("commenter")
    expect(effectiveRole(member, "org", "editor", "org")).toBe("editor") // lift
  })

  it("the floor is a max with the explicit role, never a demotion", () => {
    expect(
      effectiveRole({ kind: "user", orgRole: "viewer" }, "public", "commenter", "public"),
    ).toBe("commenter")
    expect(
      effectiveRole({ kind: "user", orgRole: "editor" }, "public", "commenter", "public"),
    ).toBe("editor")
    expect(
      effectiveRole({ kind: "user", artifactRole: "owner" }, "public", "commenter", "public"),
    ).toBe("owner")
  })

  it("a lock: the grant follows unlock, and never elevates anon", () => {
    expect(effectiveRole({ ...anon, locked: true }, "public", "commenter", "public")).toBe(null)
    expect(
      effectiveRole(
        { kind: "anon", locked: true, unlocked: true },
        "public",
        "commenter",
        "public",
      ),
    ).toBe("viewer")
    expect(
      can(
        { kind: "anon", locked: true, unlocked: true },
        "comment",
        "public",
        "commenter",
        "public",
      ),
    ).toBe(false)
    expect(
      effectiveRole(
        { kind: "user", userId: "u", locked: true, unlocked: true },
        "public",
        "commenter",
        "public",
      ),
    ).toBe("commenter")
  })

  it("the link floor is NOT public-visibility-only — org and private carry it too (round 4)", () => {
    expect(effectiveRole(anon, "org", "commenter", "public")).toBe("viewer") // anon clamped
    expect(effectiveRole(reacher, "org", "commenter", "public")).toBe("commenter")
    expect(effectiveRole(reacher, "private", "editor", "public")).toBe("editor")
  })

  it("`none` / omitted defaults grant nothing, on any visibility — fail closed", () => {
    expect(effectiveRole(reacher, "public")).toBe(null)
    expect(can(reacher, "comment", "public")).toBe(false)
    expect(effectiveRole(reacher, "public", "none", "public")).toBe(null)
  })
})
