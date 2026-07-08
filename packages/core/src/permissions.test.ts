import { describe, expect, it } from "vitest"
import {
  type Action,
  type Actor,
  can,
  effectiveRole,
  isRole,
  type LinkAudience,
  type LinkRole,
  maxRole,
  ROLES,
  type Role,
  roleAllows,
} from "./permissions"
import type { Visibility } from "./ports"

const ACTIONS: Action[] = ["read", "comment", "propose", "publish", "approve", "share", "manage"]
const VISIBILITIES: Visibility[] = ["public", "org", "private"]
const WRITE_ACTIONS: Action[] = ["comment", "propose", "publish", "approve", "share", "manage"]
const LINK_ROLES: LinkRole[] = ["none", "viewer", "commenter", "editor"]
const LINK_AUDIENCES: LinkAudience[] = ["org", "public"]

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

  it("omitted link params default to none + org — a caller fails closed, not open", () => {
    // Round 4: the DB columns default to `none`/`org`, and so do these parameters —
    // a code path that forgets to pass the artifact's link pair gets NO floor,
    // never the old `viewer` default. See docs/plans/link-grant.md.
    expect(effectiveRole(user(), "public")).toBeNull()
    expect(effectiveRole(anon, "public")).toBeNull()
  })

  // ACCEPTANCE — the two scenarios this round exists for (Anir, verbatim):
  // 1. "I publish an item — it is not discoverable — it is accessible by link
  //     only in my workspace."
  // 2. "I publish an item — it is not discoverable — it is accessible by link
  //     publicly."
  it("SCENARIO 1: private + org-audience link — workspace members with the URL, no one else", () => {
    // A member of the artifact's workspace holding the URL gets the link's grant.
    expect(effectiveRole(user({ orgRole: "commenter" }), "private", "viewer", "org")).toBe("viewer")
    expect(effectiveRole(user({ orgRole: "editor" }), "private", "commenter", "org")).toBe(
      "commenter",
    )
    // The default grant (workspace · can comment) lets any member comment.
    expect(can(user({ orgRole: "commenter" }), "comment", "private", "commenter", "org")).toBe(true)
    // A signed-in OUTSIDER holding the same URL gets nothing.
    expect(effectiveRole(user(), "private", "commenter", "org")).toBeNull()
    // Anonymous gets nothing — never in an org audience.
    expect(effectiveRole(anon, "private", "commenter", "org")).toBeNull()
  })

  it("SCENARIO 2: private + public-audience link — any holder, anon clamped to view", () => {
    expect(effectiveRole(anon, "private", "viewer", "public")).toBe("viewer")
    expect(effectiveRole(user(), "private", "viewer", "public")).toBe("viewer")
    expect(effectiveRole(user(), "private", "commenter", "public")).toBe("commenter")
    expect(effectiveRole(anon, "private", "commenter", "public")).toBe("viewer")
    expect(can(anon, "comment", "private", "commenter", "public")).toBe(false)
  })

  it("membership is the audience KEY, not the grant — an org link hands members linkRole only", () => {
    // A workspace OWNER holding a private doc's org·viewer link gets VIEWER: the
    // round-3 privacy invariant (membership grants nothing at private) stands;
    // the link grants what the link says, to those the audience admits.
    expect(effectiveRole(user({ orgRole: "owner" }), "private", "viewer", "org")).toBe("viewer")
    expect(effectiveRole(user({ orgRole: "owner" }), "private", "none", "org")).toBeNull()
  })

  it("`none` grants nothing by the link, at any visibility and audience", () => {
    for (const v of VISIBILITIES)
      for (const a of LINK_AUDIENCES) {
        expect(effectiveRole(user(), v, "none", a), `user ${v}/${a}`).toBeNull()
        expect(effectiveRole(anon, v, "none", a), `anon ${v}/${a}`).toBeNull()
      }
  })

  it("`editor` is a real link grant — publish/approve/share ride the pure role ladder", () => {
    expect(effectiveRole(user(), "private", "editor", "public")).toBe("editor")
    expect(can(user(), "publish", "private", "editor", "public")).toBe(true)
    expect(can(user(), "share", "private", "editor", "public")).toBe(true)
    expect(can(user(), "manage", "private", "editor", "public")).toBe(false) // editor, not owner
    // Org-audience editor link: members edit (state 4/11), outsiders never.
    expect(effectiveRole(user({ orgRole: "commenter" }), "org", "editor", "org")).toBe("editor")
    expect(effectiveRole(user(), "org", "editor", "org")).toBeNull()
  })

  it("a password (the lock) gates the link floor behind unlock", () => {
    expect(effectiveRole(user({ locked: true }), "public", "commenter", "public")).toBeNull()
    expect(
      effectiveRole(user({ locked: true, unlocked: true }), "public", "commenter", "public"),
    ).toBe("commenter")
    // The lock gates the FLOOR only — members and explicit shares pass by role.
    expect(effectiveRole(user({ locked: true, orgRole: "editor" }), "public")).toBe("editor")
    expect(effectiveRole(user({ locked: true, artifactRole: "commenter" }), "public")).toBe(
      "commenter",
    )
    // A lock with no explicit standing is a hard `null`, not a demotion to viewer.
    expect(
      effectiveRole(user({ locked: true, unlocked: false }), "private", "editor", "public"),
    ).toBeNull()
  })

  it("org/private grant nothing by MEMBERSHIP alone — only an explicit role opens it", () => {
    expect(effectiveRole(user(), "org")).toBeNull()
    expect(effectiveRole(user({ orgRole: "editor" }), "org")).toBe("editor")
  })

  it("an explicit per-artifact share is authoritative over the workspace role", () => {
    // A share beats membership — both to widen it...
    expect(effectiveRole(user({ artifactRole: "editor", orgRole: "viewer" }), "org")).toBe("editor")
    // ...and to narrow it (the artifact share replaces the org role, not maxes with it).
    expect(effectiveRole(user({ artifactRole: "viewer", orgRole: "editor" }), "org")).toBe("viewer")
  })

  it("the link floor can lift an explicit role but never lower it", () => {
    // On a comment link, an org viewer is lifted to commenter by the floor...
    expect(effectiveRole(user({ orgRole: "viewer" }), "public", "commenter", "public")).toBe(
      "commenter",
    )
    // ...but an editor stays editor (max of explicit and floor).
    expect(effectiveRole(user({ orgRole: "editor" }), "public", "commenter", "public")).toBe(
      "editor",
    )
    // An invited share is lifted by the floor too, never lowered.
    expect(effectiveRole(user({ artifactRole: "viewer" }), "private", "commenter", "org")).toBe(
      "viewer", // outsider share: not in the org audience, keeps their share role
    )
    expect(
      effectiveRole(
        user({ artifactRole: "viewer", orgRole: "commenter" }),
        "private",
        "commenter",
        "org",
      ),
    ).toBe("commenter") // member share: floor lifts viewer share to commenter
  })

  it("private admits only shares by standing — and the link floor works independently", () => {
    expect(effectiveRole(user({ orgRole: "owner" }), "private")).toBeNull()
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
  it("never elevates anon above viewer, for ANY visibility, audience, role, or lock", () => {
    for (const v of VISIBILITIES)
      for (const g of LINK_ROLES)
        for (const a of LINK_AUDIENCES)
          for (const locked of [false, true])
            for (const unlocked of [false, true]) {
              const role = effectiveRole({ kind: "anon", locked, unlocked }, v, g, a)
              expect(
                role === null || role === "viewer",
                `anon ${v}/${g}/${a}/locked=${locked}/unlocked=${unlocked}`,
              ).toBe(true)
            }
  })

  it("anon reaches view ONLY through a public audience — an org audience is a locked door", () => {
    expect(effectiveRole(anon, "private", "viewer", "public")).toBe("viewer")
    expect(effectiveRole(anon, "private", "editor", "public")).toBe("viewer") // clamp, not editor
    expect(effectiveRole(anon, "org", "commenter", "org")).toBeNull()
    expect(effectiveRole(anon, "public", "none", "public")).toBeNull()
    expect(
      effectiveRole({ kind: "anon", locked: true }, "public", "commenter", "public"),
    ).toBeNull()
    expect(
      effectiveRole({ kind: "anon", locked: true, unlocked: true }, "public", "viewer", "public"),
    ).toBe("viewer")
  })
})

describe("can — the one authorization gate", () => {
  it("denies every write action to an anonymous caller, on every visibility, grant, and audience", () => {
    // Not even an editor-grant public link lets an account-less caller write.
    for (const v of VISIBILITIES)
      for (const g of LINK_ROLES)
        for (const a of LINK_AUDIENCES)
          for (const action of WRITE_ACTIONS)
            expect(can(anon, action, v, g, a), `anon ${action} on ${v}/${g}/${a}`).toBe(false)
  })

  it("lets an anon caller read via a public-audience viewer link, never via an org one", () => {
    expect(can(anon, "read", "public", "viewer", "public")).toBe(true)
    expect(can(anon, "read", "public", "viewer", "org")).toBe(false)
    expect(can(anon, "read", "org")).toBe(false)
  })

  it("omitted link params deny read too — `can` fails closed the same as effectiveRole", () => {
    expect(can(anon, "read", "public")).toBe(false)
    expect(can(user(), "read", "public")).toBe(false)
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
