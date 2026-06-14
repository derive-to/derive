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
  /** The caller has entered the correct password for a `password` artifact. */
  unlocked?: boolean
}

/**
 * The actor's effective role on an artifact of this visibility:
 *   per-artifact share  →  workspace membership  →  visibility floor.
 * null means no access at all.
 */
export function effectiveRole(actor: Actor, visibility: Visibility): Role | null {
  if (actor.kind === "token") return "owner"
  if (actor.kind === "user") {
    const explicit = actor.artifactRole ?? actor.orgRole
    if (explicit) return explicit
  }
  // No membership / anonymous: public + link are world-readable as a viewer; a
  // `password` artifact opens to a viewer only once the caller has unlocked it
  // (entered the password). There is deliberately no "trusted anonymous" path —
  // an unauthenticated caller can never be elevated to a writing role.
  if (visibility === "public" || visibility === "link") return "viewer"
  if (visibility === "password") return actor.unlocked ? "viewer" : null
  return null
}

/** The one authorization gate. */
export function can(actor: Actor, action: Action, visibility: Visibility): boolean {
  const role = effectiveRole(actor, visibility)
  return role !== null && roleAllows(role, action)
}
