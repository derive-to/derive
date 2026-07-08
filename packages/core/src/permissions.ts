import type { Visibility } from "./ports"
import type { GeneralRole, Role } from "./roles"

// The role/general-access vocabulary lives in ./roles (a leaf) so ./ports and this
// module can both use it without forming an import cycle. Re-exported here so the
// long-standing `@derive/core` surface (Role, GeneralRole) stays unchanged.
export type { GeneralRole, Role } from "./roles"

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
  /** Per-artifact role override (a share), if any. Beats the workspace role. */
  artifactRole?: Role | null
  /** Baseline role from membership in the artifact's workspace, if any. */
  orgRole?: Role | null
  /** The artifact carries a password (a lock on its public link). */
  locked?: boolean
  /** The caller has entered the correct password for a locked artifact. */
  unlocked?: boolean
}

/**
 * The actor's effective role on an artifact, the max of their explicit standing and
 * the general-access floor:
 *   per-artifact share  →  workspace membership  →  general-access floor (by reach).
 * null means no access at all. This function is the single source of truth for the
 * access matrix; SECURITY.md documents the same table for humans.
 *
 *   Visibility                   Anonymous              Signed in via link    Member / share
 *   ───────────────────────────  ─────────────────────  ────────────────────  ────────────────
 *   public · view                view                   view                  their role (>= view)
 *   public · comment             view (sign in to cmt)  view + comment        their role (>= cmt)
 *   public + password            unlock, then as above  unlock, then above    their role (no pw)
 *   workspace (org)              no access              no access             their role (members)
 *   private (default)            no access              no access             explicit share only
 *
 * Three visibilities, one modifier: `public` means the link works for anyone
 * (at the doc's general role, view or comment); a password on a public doc
 * gates the reach floor until unlocked — members and explicit shares never
 * need the password. `org` is the team: membership alone grants access, at the
 * member's own role. `private` grants nothing by membership — only explicit
 * shares (per-artifact and collection shares both ride artifactRole), which is
 * what keeps an agent's draft out of teammates' reach until promoted.
 *
 * Invariant: an anonymous caller is never more than `viewer`. Anything past view
 * (comment, propose, publish, share, manage) needs an authenticated identity — a
 * signed-in user or a `DERIVE_TOKEN`. There is deliberately no "trusted anonymous" path.
 */
export function effectiveRole(
  actor: Actor,
  visibility: Visibility,
  generalRole: GeneralRole = "viewer",
): Role | null {
  if (actor.kind === "token") return "owner"
  // A per-artifact share or workspace membership — authenticated callers only.
  // `private` is the exception: workspace membership grants nothing there by
  // itself, so a team-workspace draft stays out of teammates' standing until
  // explicitly shared.
  const explicit =
    actor.kind === "user"
      ? visibility === "private"
        ? actor.artifactRole
        : (actor.artifactRole ?? actor.orgRole)
      : null
  // The general-access floor for a reacher with no higher explicit grant. Only an
  // authenticated reacher gets the configured general role; an anonymous reacher is
  // clamped to `viewer` — never elevated to a writing role without an account. A
  // password (the lock) suspends the floor until unlocked; explicit standing above
  // is untouched, so members and shares never need the password.
  const reach: Role = actor.kind === "user" ? generalRole : "viewer"
  const floor: Role | null =
    visibility === "public" ? (actor.locked && !actor.unlocked ? null : reach) : null
  // org/private grant nothing by reach — only an explicit role opens them.
  return maxRole(explicit, floor)
}

/** The one authorization gate. */
export function can(
  actor: Actor,
  action: Action,
  visibility: Visibility,
  generalRole: GeneralRole = "viewer",
): boolean {
  const role = effectiveRole(actor, visibility, generalRole)
  return role !== null && roleAllows(role, action)
}
