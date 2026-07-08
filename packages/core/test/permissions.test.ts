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

  it("a member opens at their seat role when workspace_access=member", () => {
    expect(effectiveRole(user({ orgRole: "commenter" }), "member")).toBe("commenter")
    expect(effectiveRole(user({ orgRole: "editor" }), "member")).toBe("editor")
  })
  it("a share widens the seat but never narrows it (v2 is additive)", () => {
    expect(effectiveRole(user({ orgRole: "viewer", artifactRole: "editor" }), "member")).toBe(
      "editor",
    )
    // A viewer share does NOT drop an editor member — the seat wins.
    expect(effectiveRole(user({ orgRole: "editor", artifactRole: "viewer" }), "member")).toBe(
      "editor",
    )
  })
  it("a non-member gets nothing without a world link, and nothing on a lock", () => {
    expect(effectiveRole(user({}), "none")).toBe(null)
    expect(effectiveRole(user({}), "none", "viewer")).toBe("viewer")
    expect(effectiveRole(user({}), "member")).toBe(null) // no seat
    expect(effectiveRole(user({ locked: true }), "none", "viewer")).toBe(null)
  })
  it("a static token is owner; an anonymous caller is always read-only, never above viewer", () => {
    expect(effectiveRole({ kind: "token" }, "member")).toBe("owner")
    // No "open"/trusted-anonymous path exists: anon never gets a writing role, even
    // on an editor-grant world link, and never gets a workspace seat.
    expect(effectiveRole({ kind: "anon" }, "member")).toBe(null)
    expect(effectiveRole({ kind: "anon" }, "none", "viewer")).toBe("viewer")
    expect(effectiveRole({ kind: "anon" }, "none", "editor")).toBe("viewer")
  })
})

describe("can", () => {
  it("an editor publishes, a commenter cannot", () => {
    expect(can({ kind: "user", artifactRole: "editor" }, "publish", "member")).toBe(true)
    expect(can({ kind: "user", artifactRole: "commenter" }, "publish", "member")).toBe(false)
    expect(can({ kind: "user", artifactRole: "commenter" }, "comment", "member")).toBe(true)
  })
  it("a world viewer link reads but cannot comment", () => {
    expect(can({ kind: "anon" }, "read", "none", "viewer")).toBe(true)
    expect(can({ kind: "anon" }, "comment", "none", "viewer")).toBe(false)
  })
})

// The world link (docs/plans/access-model.md), every cell of the matrix. The
// invariants: an anonymous holder is NEVER more than viewer; the link grants any
// signed-in holder (member or not) its role; a non-member gets NOTHING by
// workspace access. Mirrors SECURITY.md.
describe("the world link (access matrix)", () => {
  const anon: Actor = { kind: "anon" }
  // A signed-in caller with no share/seat — reaching purely via the world link.
  const outsider: Actor = { kind: "user", userId: "u9" }
  // A signed-in member of the artifact's workspace.
  const member: Actor = { kind: "user", userId: "u10", orgRole: "commenter" }

  it("world view link: everyone reaching is viewer, nobody can comment", () => {
    expect(effectiveRole(anon, "none", "viewer")).toBe("viewer")
    expect(effectiveRole(outsider, "none", "viewer")).toBe("viewer")
    expect(can(anon, "comment", "none", "viewer")).toBe(false)
    expect(can(outsider, "comment", "none", "viewer")).toBe(false)
  })

  it("world comment link: anon stays viewer (forced auth), a signed-in holder becomes commenter", () => {
    expect(effectiveRole(anon, "none", "commenter")).toBe("viewer")
    expect(can(anon, "comment", "none", "commenter")).toBe(false) // anon never elevated
    expect(can(anon, "read", "none", "commenter")).toBe(true)
    expect(effectiveRole(outsider, "none", "commenter")).toBe("commenter")
    expect(can(outsider, "comment", "none", "commenter")).toBe(true)
  })

  it("workspace access: members in at their seat, outsiders and anon out", () => {
    // The default team draft (member + no link): the member gets their seat...
    expect(effectiveRole(member, "member", "none")).toBe("commenter")
    // ...an outsider and anon get nothing.
    expect(effectiveRole(outsider, "member", "none")).toBeNull()
    expect(effectiveRole(anon, "member", "none")).toBeNull()
    // The world link is a max with the seat: a lower link is a no-op, a higher one lifts.
    expect(effectiveRole(member, "member", "viewer")).toBe("commenter")
    expect(effectiveRole(member, "member", "editor")).toBe("editor") // lift
  })

  it("the world link is a max with the seat/share, never a demotion", () => {
    expect(effectiveRole({ kind: "user", orgRole: "viewer" }, "member", "commenter")).toBe(
      "commenter",
    )
    expect(effectiveRole({ kind: "user", orgRole: "editor" }, "member", "commenter")).toBe("editor")
    expect(effectiveRole({ kind: "user", artifactRole: "owner" }, "none", "commenter")).toBe(
      "owner",
    )
  })

  it("a lock: the world grant follows unlock, and never elevates anon", () => {
    expect(effectiveRole({ ...anon, locked: true }, "none", "commenter")).toBe(null)
    expect(effectiveRole({ kind: "anon", locked: true, unlocked: true }, "none", "commenter")).toBe(
      "viewer",
    )
    expect(
      can({ kind: "anon", locked: true, unlocked: true }, "comment", "none", "commenter"),
    ).toBe(false)
    expect(
      effectiveRole(
        { kind: "user", userId: "u", locked: true, unlocked: true },
        "none",
        "commenter",
      ),
    ).toBe("commenter")
  })

  it("the seat is independent of the world link — a member never needs the link", () => {
    expect(effectiveRole(member, "member", "none")).toBe("commenter")
    expect(effectiveRole({ kind: "user", orgRole: "editor" }, "member", "none")).toBe("editor")
  })

  it("`none` / omitted defaults grant nothing — fail closed", () => {
    expect(effectiveRole(outsider, "none")).toBe(null)
    expect(can(outsider, "comment", "none")).toBe(false)
    expect(effectiveRole(outsider, "none", "none")).toBe(null)
  })
})
