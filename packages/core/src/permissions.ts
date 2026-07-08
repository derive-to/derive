import type { Visibility } from "./ports"

/**
 * The role vocabulary, in increasing power. A higher role can do everything a
 * lower one can.
 *  - viewer:    read
 *  - commenter: + comment, and propose a candidate version for review
 *               (creates content to be reviewed; cannot publish/approve)
 *  - editor:    + publish versions directly, approve others' proposals, and
 *               share (invite collaborators, change general access)
 *  - owner:     + manage (transfer/settings, delete)
 */
export type Role = "viewer" | "commenter" | "editor" | "owner"

/** The link grant (round 4, docs/plans/link-grant.md) is a PAIR on every artifact,
 *  orthogonal to visibility (which is purely a listing ladder):
 *
 *    link_audience — WHO the URL works for:  `org` (signed-in members of the
 *                    artifact's workspace) or `public` (any holder).
 *    link_role     — WHAT it grants them:    `none` (inert, invite-only),
 *                    `viewer`, `commenter`, or `editor`.
 *
 *  Together they express the three-stop dial: "the link works for no one /
 *  people in my workspace / everyone", at a capability. A `private` (unlisted)
 *  artifact with an `org`-audience link is the product default: invisible in
 *  every feed and library, but a teammate who's handed the URL just opens it.
 *  Anonymous holders are always clamped to `viewer` (and are never in an `org`
 *  audience at all) — see effectiveRole. */
export type LinkRole = "none" | "viewer" | "commenter" | "editor"
/** Who a link works for: the artifact's workspace (signed-in members only) or
 *  everyone. Meaningless while `link_role` is `none`. */
export type LinkAudience = "org" | "public"
/** @deprecated round 4 retired this in favor of `LinkRole` (a strict superset: adds
 *  `none` and `editor`, and applies at every visibility, not just `public`). Kept
 *  only to type the orphaned `general_role` DB column — expand/contract, not
 *  dropped (CONTRIBUTING.md). No code reads or writes it anymore. */
export type GeneralRole = "viewer" | "commenter"

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
 * the link floor:
 *
 *   access = max( explicit standing , link floor )
 *
 * null means no access at all. This function is the single source of truth for the
 * access matrix; SECURITY.md documents the full 21-state table for humans.
 *
 * EXPLICIT STANDING — a per-artifact share / collection share (artifactRole)
 * always counts; the workspace membership role (orgRole) counts at `org`/`public`
 * visibility only. At `private`, membership grants NOTHING (round-3 draft
 * privacy: a workspace OWNER still cannot open a teammate's private draft by
 * role alone — only a share or the link).
 *
 * THE LINK FLOOR (round 4, docs/plans/link-grant.md) — what merely holding the
 * URL confers, orthogonal to where the artifact is listed:
 *   - linkRole `none` → no floor (the link is inert; audience irrelevant).
 *   - the holder must be IN THE AUDIENCE: `public` admits every holder;
 *     `org` admits only signed-in members of the ARTIFACT's workspace
 *     (actor.orgRole != null) — anonymous is never in an `org` audience.
 *   - an anonymous holder is always clamped to `viewer` — never elevated to a
 *     writing role without an account.
 *   - a password (the lock, `public` visibility only) suspends the floor until
 *     unlocked; explicit standing is untouched, so members and shares never
 *     need the password.
 *
 * The pair expresses the three-stop dial: the link works for no one (`none`) /
 * people in my workspace (`org` audience) / everyone (`public` audience), at a
 * capability. A `private` (unlisted) artifact with an org-audience link is the
 * product default: invisible in every feed and library, but a teammate who is
 * handed the URL just opens it.
 *
 * Invariant: an anonymous caller is never more than `viewer`, regardless of the
 * grant. Anything past view (comment, propose, publish, share, manage) needs an
 * authenticated identity — a signed-in user or a `DERIVE_TOKEN`. There is
 * deliberately no "trusted anonymous" path.
 */
export function effectiveRole(
  actor: Actor,
  visibility: Visibility,
  linkRole: LinkRole = "none",
  linkAudience: LinkAudience = "org",
): Role | null {
  if (actor.kind === "token") return "owner"
  // A per-artifact share or workspace membership — authenticated callers only.
  // `private` is the exception: workspace membership grants nothing there by
  // itself, so a team-workspace draft stays out of teammates' standing until
  // explicitly shared (or reached through the link floor below).
  const explicit =
    actor.kind === "user"
      ? visibility === "private"
        ? actor.artifactRole
        : (actor.artifactRole ?? actor.orgRole)
      : null
  // Is this holder in the link's audience? `public` admits everyone; `org` admits
  // only signed-in members of the artifact's workspace. Membership is the audience
  // KEY here, not the grant — an org-audience link hands a member linkRole, never
  // their workspace role (private stays private-by-role).
  const inAudience = linkAudience === "public" || (actor.kind === "user" && actor.orgRole != null)
  const reach: Role | null =
    linkRole === "none" || !inAudience ? null : actor.kind === "user" ? linkRole : "viewer"
  const floor: Role | null = actor.locked && !actor.unlocked ? null : reach
  return maxRole(explicit, floor)
}

/** The one authorization gate. */
export function can(
  actor: Actor,
  action: Action,
  visibility: Visibility,
  linkRole: LinkRole = "none",
  linkAudience: LinkAudience = "org",
): boolean {
  const role = effectiveRole(actor, visibility, linkRole, linkAudience)
  return role !== null && roleAllows(role, action)
}
