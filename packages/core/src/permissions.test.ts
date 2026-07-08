import { describe, expect, it } from "vitest"
import {
  type Action,
  type Actor,
  can,
  effectiveRole,
  isRole,
  type LinkRole,
  maxRole,
  ROLES,
  type Role,
  roleAllows,
  type WorkspaceAccess,
} from "./permissions"

const ACTIONS: Action[] = ["read", "comment", "propose", "publish", "approve", "share", "manage"]
const WRITE_ACTIONS: Action[] = ["comment", "propose", "publish", "approve", "share", "manage"]
const LINK_ROLES: LinkRole[] = ["none", "viewer", "commenter", "editor"]
const WORKSPACE_ACCESS: WorkspaceAccess[] = ["none", "member"]

// The authoritative access matrix: the minimum role each action requires. This is
// the security contract — duplicated from NEEDS in permissions.ts on purpose so a
// change to the gate must be a DELIBERATE change here too, never a silent drift.
const MIN_ROLE: Record<Action, Role> = {
  read: "viewer",
  comment: "commenter",
  propose: "commenter",
  publish: "editor",
  approve: "editor",
  share: "editor",
  manage: "owner",
}

const rank = (r: Role) => ROLES.indexOf(r)

describe("roleAllows — the action/role matrix", () => {
  it("permits exactly the roles at or above each action's minimum", () => {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        const expected = rank(role) >= rank(MIN_ROLE[action])
        expect(roleAllows(role, action), `${role} → ${action}`).toBe(expected)
      }
    }
  })

  it("is monotonic: a higher role can do everything a lower role can", () => {
    for (let i = 0; i < ROLES.length - 1; i++) {
      const lower = ROLES[i] as Role
      const higher = ROLES[i + 1] as Role
      for (const action of ACTIONS)
        if (roleAllows(lower, action))
          expect(roleAllows(higher, action), `${higher} ⊇ ${lower} for ${action}`).toBe(true)
    }
  })

  it("encodes the review gate: a commenter may propose but not publish or approve", () => {
    expect(roleAllows("commenter", "propose")).toBe(true)
    expect(roleAllows("commenter", "publish")).toBe(false)
    expect(roleAllows("commenter", "approve")).toBe(false)
  })

  it("keeps manage owner-only", () => {
    expect(roleAllows("editor", "manage")).toBe(false)
    expect(roleAllows("owner", "manage")).toBe(true)
  })
})

describe("maxRole", () => {
  it("returns the highest role and ignores null/undefined", () => {
    expect(maxRole("viewer", "editor", "commenter")).toBe("editor")
    expect(maxRole(null, "commenter", undefined)).toBe("commenter")
    expect(maxRole("owner", "viewer")).toBe("owner")
  })

  it("returns null when nothing is supplied", () => {
    expect(maxRole()).toBeNull()
    expect(maxRole(null, undefined)).toBeNull()
  })
})

describe("isRole", () => {
  it("accepts the four roles and rejects everything else", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true)
    for (const v of ["admin", "", "VIEWER", null, undefined, 2, {}]) expect(isRole(v)).toBe(false)
  })
})

const anon: Actor = { kind: "anon" }
const token: Actor = { kind: "token" }
const user = (over: Partial<Actor> = {}): Actor => ({ kind: "user", userId: "u1", ...over })

describe("effectiveRole — the three grants (max of explicit, seat, world)", () => {
  it("a DERIVE_TOKEN actor is always owner", () => {
    for (const wa of WORKSPACE_ACCESS)
      for (const lr of LINK_ROLES) expect(effectiveRole(token, wa, lr)).toBe("owner")
  })

  it("omitted params fail closed — no workspace access, no link, no access", () => {
    // A member with no workspace_access on the artifact still gets nothing by seat.
    expect(effectiveRole(user({ orgRole: "editor" }))).toBeNull()
    expect(effectiveRole(user())).toBeNull()
    expect(effectiveRole(anon)).toBeNull()
  })

  // SEAT — workspace_access=member opens each member at their OWN workspace role.
  it("workspace_access=member opens each member at their seat role", () => {
    expect(effectiveRole(user({ orgRole: "editor" }), "member")).toBe("editor")
    expect(effectiveRole(user({ orgRole: "commenter" }), "member")).toBe("commenter")
    expect(effectiveRole(user({ orgRole: "owner" }), "member")).toBe("owner")
    // A signed-in NON-member (no seat) gets nothing from workspace access.
    expect(effectiveRole(user(), "member")).toBeNull()
    // Anonymous is never a member.
    expect(effectiveRole(anon, "member")).toBeNull()
  })

  it("workspace_access=none grants members nothing (invite-/external-only)", () => {
    expect(effectiveRole(user({ orgRole: "owner" }), "none")).toBeNull()
    expect(effectiveRole(user({ orgRole: "owner" }), "none", "none")).toBeNull()
  })

  // THE FIX — a workspace editor edits an unlisted draft, never floored to a link.
  it("a workspace editor edits the default team draft (member + no link)", () => {
    expect(effectiveRole(user({ orgRole: "editor" }), "member", "none")).toBe("editor")
    // Even beside a lower world link, the seat wins (max, never a floor-down).
    expect(effectiveRole(user({ orgRole: "editor" }), "member", "commenter")).toBe("editor")
  })

  // WORLD LINK — anyone with the URL, incl. non-members; anon clamps to viewer.
  it("the world link grants any signed-in holder its role; a non-member too", () => {
    expect(effectiveRole(user(), "none", "viewer")).toBe("viewer")
    expect(effectiveRole(user(), "none", "commenter")).toBe("commenter")
    // A signed-in outsider (no seat) still gets the world grant — "anyone with the link".
    expect(effectiveRole(user({ orgRole: null }), "none", "commenter")).toBe("commenter")
  })

  it("an anonymous holder is clamped to viewer, whatever the world role", () => {
    expect(effectiveRole(anon, "none", "viewer")).toBe("viewer")
    expect(effectiveRole(anon, "none", "commenter")).toBe("viewer")
    expect(effectiveRole(anon, "none", "editor")).toBe("viewer")
    expect(can(anon, "comment", "none", "commenter")).toBe(false)
  })

  it("link_role=none is an inert link — no world grant", () => {
    expect(effectiveRole(user(), "none", "none")).toBeNull()
    expect(effectiveRole(anon, "none", "none")).toBeNull()
    expect(effectiveRole(user({ orgRole: "editor" }), "none", "none")).toBeNull()
  })

  it("editor is a real world grant — publish/approve/share ride the ladder, not manage", () => {
    expect(effectiveRole(user(), "none", "editor")).toBe("editor")
    expect(can(user(), "publish", "none", "editor")).toBe(true)
    expect(can(user(), "share", "none", "editor")).toBe(true)
    expect(can(user(), "manage", "none", "editor")).toBe(false) // editor, not owner
  })

  // MAX — the three grants compose by max; nothing narrows below another.
  it("access is the max of explicit share, seat, and world link", () => {
    // The world link lifts a member below it…
    expect(effectiveRole(user({ orgRole: "viewer" }), "member", "commenter")).toBe("commenter")
    // …but never lowers one above it (seat wins).
    expect(effectiveRole(user({ orgRole: "editor" }), "member", "viewer")).toBe("editor")
    // A share alone (no workspace access, no link) grants its role.
    expect(effectiveRole(user({ artifactRole: "commenter" }))).toBe("commenter")
    // A share lifts a lower seat…
    expect(effectiveRole(user({ artifactRole: "owner", orgRole: "commenter" }), "member")).toBe(
      "owner",
    )
    // …and does NOT narrow a higher seat (v2 is additive — a share can only widen).
    expect(effectiveRole(user({ artifactRole: "viewer", orgRole: "editor" }), "member")).toBe(
      "editor",
    )
  })

  // PASSWORD — the lock gates the WORLD link only; seat and shares never need it.
  it("a password gates the world link behind unlock", () => {
    expect(effectiveRole(user({ locked: true }), "none", "commenter")).toBeNull()
    expect(effectiveRole(user({ locked: true, unlocked: true }), "none", "commenter")).toBe(
      "commenter",
    )
    // The lock gates the world floor only — a member's seat and a share pass by role.
    expect(effectiveRole(user({ locked: true, orgRole: "editor" }), "member", "viewer")).toBe(
      "editor",
    )
    expect(effectiveRole(user({ locked: true, artifactRole: "commenter" }), "none", "viewer")).toBe(
      "commenter",
    )
    // A lock with no other standing is a hard null, not a demotion to viewer.
    expect(effectiveRole(user({ locked: true }), "none", "editor")).toBeNull()
  })
})

describe("effectiveRole — the anonymous invariant", () => {
  it("never elevates anon above viewer, for ANY workspace access, world role, or lock", () => {
    for (const wa of WORKSPACE_ACCESS)
      for (const lr of LINK_ROLES)
        for (const locked of [false, true])
          for (const unlocked of [false, true]) {
            const role = effectiveRole({ kind: "anon", locked, unlocked }, wa, lr)
            expect(
              role === null || role === "viewer",
              `anon ${wa}/${lr}/locked=${locked}/unlocked=${unlocked}`,
            ).toBe(true)
          }
  })

  it("anon reaches view ONLY through the world link — never through workspace access", () => {
    expect(effectiveRole(anon, "none", "viewer")).toBe("viewer")
    expect(effectiveRole(anon, "none", "editor")).toBe("viewer") // clamp, not editor
    expect(effectiveRole(anon, "member", "none")).toBeNull() // never a member
    expect(effectiveRole(anon, "none", "none")).toBeNull()
    expect(effectiveRole({ kind: "anon", locked: true }, "none", "commenter")).toBeNull()
    expect(effectiveRole({ kind: "anon", locked: true, unlocked: true }, "none", "viewer")).toBe(
      "viewer",
    )
  })
})

describe("can — the one authorization gate", () => {
  it("denies every write action to an anonymous caller, on every workspace access and world role", () => {
    // Not even an editor-grant world link lets an account-less caller write.
    for (const wa of WORKSPACE_ACCESS)
      for (const lr of LINK_ROLES)
        for (const action of WRITE_ACTIONS)
          expect(can(anon, action, wa, lr), `anon ${action} on ${wa}/${lr}`).toBe(false)
  })

  it("lets an anon caller read via a world viewer link, never via workspace access", () => {
    expect(can(anon, "read", "none", "viewer")).toBe(true)
    expect(can(anon, "read", "member", "none")).toBe(false)
    expect(can(anon, "read", "none", "none")).toBe(false)
  })

  it("omitted params deny read too — `can` fails closed the same as effectiveRole", () => {
    expect(can(anon, "read")).toBe(false)
    expect(can(user(), "read")).toBe(false)
  })

  it("routes a commenter through propose, never publish", () => {
    const commenter = user({ orgRole: "commenter" })
    expect(can(commenter, "comment", "member")).toBe(true)
    expect(can(commenter, "propose", "member")).toBe(true)
    expect(can(commenter, "publish", "member")).toBe(false)
    expect(can(commenter, "approve", "member")).toBe(false)
  })

  it("lets a token (CI/agent) do everything", () => {
    for (const action of ACTIONS) expect(can(token, action, "member")).toBe(true)
  })

  it("a bare viewer can read but not comment", () => {
    expect(can(user({ orgRole: "viewer" }), "read", "member")).toBe(true)
    expect(can(user({ orgRole: "viewer" }), "comment", "member")).toBe(false)
  })
})
