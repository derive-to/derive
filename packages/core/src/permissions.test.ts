import { describe, expect, it } from "vitest"
import {
  type Action,
  type Actor,
  can,
  effectiveRole,
  type GeneralRole,
  isRole,
  maxRole,
  ROLES,
  type Role,
  roleAllows,
} from "./permissions"
import type { Visibility } from "./ports"

const ACTIONS: Action[] = ["read", "comment", "propose", "publish", "approve", "share", "manage"]
const VISIBILITIES: Visibility[] = ["public", "link", "password", "org", "private", "unlisted"]
const WRITE_ACTIONS: Action[] = ["comment", "propose", "publish", "approve", "share", "manage"]

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

describe("effectiveRole — the documented access table", () => {
  it("a DERIVE_TOKEN actor is always owner, on every visibility", () => {
    for (const v of VISIBILITIES) expect(effectiveRole(token, v)).toBe("owner")
  })

  it("link/public grant the general-access floor to a signed-in reacher", () => {
    // Default floor is view; a comment link lifts a signed-in reacher to commenter.
    expect(effectiveRole(user(), "link")).toBe("viewer")
    expect(effectiveRole(user(), "link", "commenter")).toBe("commenter")
    expect(effectiveRole(user(), "public", "commenter")).toBe("commenter")
  })

  it("password gates the floor behind unlock", () => {
    expect(effectiveRole(user(), "password", "commenter")).toBeNull()
    expect(effectiveRole(user({ unlocked: true }), "password", "commenter")).toBe("commenter")
  })

  it("org/private grants nothing by reach — only an explicit role opens it", () => {
    expect(effectiveRole(user(), "org", "commenter")).toBeNull()
    expect(effectiveRole(user({ orgRole: "editor" }), "org")).toBe("editor")
  })

  it("an explicit per-artifact share is authoritative over the workspace role", () => {
    // A share beats membership — both to widen it...
    expect(effectiveRole(user({ artifactRole: "editor", orgRole: "viewer" }), "org")).toBe("editor")
    // ...and to narrow it (the artifact share replaces the org role, not maxes with it).
    expect(effectiveRole(user({ artifactRole: "viewer", orgRole: "editor" }), "org")).toBe("viewer")
  })

  it("the general-access floor can lift an explicit role but never lower it", () => {
    // On a comment link, an org viewer is lifted to commenter by the floor...
    expect(effectiveRole(user({ orgRole: "viewer" }), "link", "commenter")).toBe("commenter")
    // ...but an editor stays editor (max of explicit and floor).
    expect(effectiveRole(user({ orgRole: "editor" }), "link", "commenter")).toBe("editor")
  })

  it("unlisted opens for workspace members at the general role — nobody else", () => {
    // Workspace link-only: a member WITH THE LINK gets the workspace's default
    // (view or comment). Their workspace role itself grants nothing (that would
    // be `org`), so an unlisted doc never rides membership into listings/standing.
    expect(effectiveRole(user({ orgRole: "viewer" }), "unlisted")).toBe("viewer")
    expect(effectiveRole(user({ orgRole: "viewer" }), "unlisted", "commenter")).toBe("commenter")
    // An org editor still only gets the floor — membership is reach, not standing.
    expect(effectiveRole(user({ orgRole: "editor" }), "unlisted")).toBe("viewer")
    // Non-members (no orgRole) and anonymous visitors get nothing.
    expect(effectiveRole(user(), "unlisted", "commenter")).toBeNull()
    expect(effectiveRole(anon, "unlisted", "commenter")).toBeNull()
    // An explicit share still opens it at the shared role (and can exceed the floor).
    expect(effectiveRole(user({ artifactRole: "owner" }), "unlisted")).toBe("owner")
    expect(effectiveRole(user({ artifactRole: "editor", orgRole: "viewer" }), "unlisted")).toBe(
      "editor",
    )
    expect(effectiveRole(token, "unlisted")).toBe("owner")
  })

  it("private admits only per-artifact members — workspace role grants nothing", () => {
    // The distinction from org: a workspace editor cannot see a teammate's
    // private draft, but an explicit share (or the creator's owner-member row,
    // written at publish) opens it. Collection shares ride artifactRole too.
    expect(effectiveRole(user({ orgRole: "owner" }), "private")).toBeNull()
    expect(effectiveRole(user({ orgRole: "editor" }), "private", "commenter")).toBeNull()
    expect(effectiveRole(user({ artifactRole: "owner" }), "private")).toBe("owner")
    expect(effectiveRole(user({ artifactRole: "commenter", orgRole: "editor" }), "private")).toBe(
      "commenter",
    )
    expect(effectiveRole(anon, "private")).toBeNull()
    // The operator token stays owner everywhere.
    expect(effectiveRole(token, "private")).toBe("owner")
  })
})

describe("effectiveRole — the anonymous invariant", () => {
  it("never elevates an anonymous caller above viewer, for ANY visibility or general role", () => {
    const generalRoles: GeneralRole[] = ["viewer", "commenter"]
    for (const v of VISIBILITIES) {
      for (const g of generalRoles) {
        for (const unlocked of [false, true]) {
          const role = effectiveRole({ kind: "anon", unlocked }, v, g)
          expect(role === null || role === "viewer", `anon ${v}/${g}/unlocked=${unlocked}`).toBe(
            true,
          )
        }
      }
    }
  })

  it("gives an anon caller view on an open link, and no access on org", () => {
    expect(effectiveRole(anon, "link", "commenter")).toBe("viewer")
    expect(effectiveRole(anon, "public")).toBe("viewer")
    expect(effectiveRole(anon, "org", "commenter")).toBeNull()
    expect(effectiveRole(anon, "password", "commenter")).toBeNull()
  })
})

describe("can — the one authorization gate", () => {
  it("denies every write action to an anonymous caller, on every visibility", () => {
    // Even a comment-general-access link does not let an account-less caller write.
    for (const v of VISIBILITIES)
      for (const action of WRITE_ACTIONS)
        expect(can(anon, action, v, "commenter"), `anon ${action} on ${v}`).toBe(false)
  })

  it("lets an anon caller read an open link but not a private one", () => {
    expect(can(anon, "read", "link")).toBe(true)
    expect(can(anon, "read", "org")).toBe(false)
  })

  it("routes a commenter through propose, never publish", () => {
    const commenter = user({ orgRole: "commenter" })
    expect(can(commenter, "comment", "org")).toBe(true)
    expect(can(commenter, "propose", "org")).toBe(true)
    expect(can(commenter, "publish", "org")).toBe(false)
    expect(can(commenter, "approve", "org")).toBe(false)
  })

  it("lets a token (CI/agent) do everything", () => {
    for (const action of ACTIONS) expect(can(token, action, "org")).toBe(true)
  })

  it("a bare viewer can read but not comment", () => {
    expect(can(user({ orgRole: "viewer" }), "read", "org")).toBe(true)
    expect(can(user({ orgRole: "viewer" }), "comment", "org")).toBe(false)
  })
})
