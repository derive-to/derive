import type { LinkRole, Role, WorkspaceAccess } from "./roles"

// The access vocabulary lives in ./roles (a leaf) so ./ports and this module can
// both use it without forming an import cycle. Re-exported here so the long-standing
// `@derive/core` surface stays unchanged (roles is not itself in the index barrel).
export type { LinkRole, Listed, Role, WorkspaceAccess } from "./roles"
// Values (not just types) from the roles leaf, so the db package can count billable
// seats in SQL off the same list the API filters with.
export { BILLABLE_ROLES, isBillableRole } from "./roles"

/** What an actor wants to do. Kept coarse on purpose; `can()` is the only gate. */
export type Action = "read" | "comment" | "propose" | "publish" | "approve" | "share" | "manage"

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 }
const NEEDS: Record<Action, Role> = {
  read: "viewer",
  comment: "commenter",
  // A commenter can propose a candidate version, but an editor must approve it
  // before it goes live. This is the review gate: propose ≠ publish.
  propose: "commenter",
  publish: "editor",
  approve: "editor",
  // Editors can share (invite people, change general access) — GDocs model — but
  // not `manage` (transfer ownership, delete), which stays owner-only.
  share: "editor",
  manage: "owner",
}

export const ROLES: readonly Role[] = ["viewer", "commenter", "editor", "owner"]
export const isRole = (v: unknown): v is Role => typeof v === "string" && v in RANK

/** Does this role permit this action? */
export const roleAllows = (role: Role, action: Action): boolean => RANK[role] >= RANK[NEEDS[action]]

/** The highest of a set of roles (nulls ignored); null if none. Folds a
 *  collection-membership role in alongside a per-artifact share. */
export function maxRole(...roles: (Role | null | undefined)[]): Role | null {
  let best: Role | null = null
  for (const r of roles) if (r && (best === null || RANK[r] > RANK[best])) best = r
  return best
}

/** Clamp a role to a ceiling. An agent borrows its registrant's standing but
 *  never rises above the role it was registered with — a workspace owner's
 *  agent registered as editor acts as editor, so no agent can `manage`
 *  (delete, transfer) regardless of whose authority it borrows. */
export function capRole(role: Role, cap: Role): Role
export function capRole(role: Role | null, cap: Role): Role | null
export function capRole(role: Role | null, cap: Role): Role | null {
  if (!role) return null
  return RANK[role] > RANK[cap] ? cap : role
}

/**
 * Who is making a request, with their standing already resolved from the store.
 * Every surface (web session, static token, MCP agent) becomes one of these.
 */
export interface Actor {
  kind: "user" | "token" | "anon"
  userId?: string
  /** Already-scoped per-artifact role. Request adapters remove workspace-bound
   *  owner/seat grants before constructing an actor outside the active workspace. */
  artifactRole?: Role | null
  /** Baseline role from membership in the artifact's workspace, if any. */
  orgRole?: Role | null
  /** The artifact carries a password (a lock on its public link). */
  locked?: boolean
  /** The caller has entered the correct password for a locked artifact. */
  unlocked?: boolean
  /** An already-authorized world-link grant inherited from a container. Its own
   *  password gate has been resolved while assembling this Actor. */
  inheritedLinkRole?: Exclude<LinkRole, "none"> | null
}

/**
 * The actor's effective role on an artifact — the max of three independent grants
 * (docs/access-model.md). null means no access at all. The single source of
 * truth for the access matrix; SECURITY.md documents the same for humans.
 *
 *   access = max( explicit share , workspace seat , world link , inherited link )
 *
 * EXPLICIT (`artifactRole`) — an already-scoped per-artifact or collection grant.
 * Portable collaborator shares always count; request adapters omit workspace-bound
 * owner grants when the artifact's workspace is not active.
 *
 * WORKSPACE SEAT — when `workspaceAccess === "member"`, a signed-in member of the
 * ARTIFACT's workspace opens at their OWN seat role (`orgRole`): an editor edits,
 * a commenter comments. When `none`, membership grants nothing (an invite-only or
 * external-only doc). There is no per-doc workspace role — seats are the role.
 *
 * WORLD LINK — what merely holding the URL confers, to anyone (non-member, public,
 * anonymous):
 *   - `linkRole === "none"` → the link is inert.
 *   - a password (the lock) suspends it until unlocked; explicit standing and the
 *     workspace seat are untouched, so members and shares never need the password.
 *   - a signed-in holder gets `linkRole`; an anonymous holder is always clamped to
 *     `viewer` — never elevated to a writing role without an account.
 *
 * Note there is NO listing input: discovery (`listed`) carries no access, so it is
 * not part of this gate.
 *
 * Invariant: an anonymous caller is never more than `viewer`, regardless of the
 * grant. Anything past view (comment, propose, publish, share, manage) needs an
 * authenticated identity — a signed-in user or a `DERIVE_TOKEN`. There is
 * deliberately no "trusted anonymous" path.
 */
export function effectiveRole(
  actor: Actor,
  workspaceAccess: WorkspaceAccess = "none",
  linkRole: LinkRole = "none",
): Role | null {
  if (actor.kind === "token") return "owner"
  // A per-artifact / collection share — authenticated callers only.
  const explicit = actor.kind === "user" ? (actor.artifactRole ?? null) : null
  // The workspace seat: a member of THIS workspace opens at their own role, but
  // only when the artifact grants workspace access.
  const seat: Role | null =
    workspaceAccess === "member" && actor.kind === "user" ? (actor.orgRole ?? null) : null
  // The world link: anyone with the URL. A password suspends it until unlocked; an
  // anonymous holder is clamped to viewer.
  const world: Role | null =
    linkRole === "none"
      ? null
      : actor.locked && !actor.unlocked
        ? null
        : actor.kind === "user"
          ? linkRole
          : "viewer"
  const inheritedWorld: Role | null = actor.inheritedLinkRole
    ? actor.kind === "user"
      ? actor.inheritedLinkRole
      : "viewer"
    : null
  return maxRole(explicit, seat, world, inheritedWorld)
}

/** Whether access comes from an active workspace seat or collaborator grant,
 * rather than a world link. */
export function hasArtifactStanding(
  actor: Actor,
  workspaceAccess: WorkspaceAccess = "none",
): boolean {
  if (actor.kind === "token") return true
  if (actor.kind !== "user") return false
  return actor.artifactRole != null || (workspaceAccess === "member" && actor.orgRole != null)
}

/** The one authorization gate. */
export function can(
  actor: Actor,
  action: Action,
  workspaceAccess: WorkspaceAccess = "none",
  linkRole: LinkRole = "none",
): boolean {
  const role = effectiveRole(actor, workspaceAccess, linkRole)
  return role !== null && roleAllows(role, action)
}
