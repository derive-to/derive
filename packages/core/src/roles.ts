/**
 * The role vocabulary, in increasing power. A higher role can do everything a
 * lower one can.
 *  - viewer:    read
 *  - commenter: + comment, and propose a candidate version for review
 *               (creates content to be reviewed; cannot publish/approve)
 *  - editor:    + publish versions directly, approve others' proposals, and
 *               share (invite collaborators, change general access)
 *  - owner:     + manage (transfer/settings, delete)
 *
 * This lives in its own leaf module — imported by BOTH ./ports and ./permissions —
 * so the store contract (which names roles in method signatures) and the authz
 * logic don't form an import cycle over the shared vocabulary.
 */
export type Role = "viewer" | "commenter" | "editor" | "owner"

/** The roles Stripe bills a seat for: write access is metered, reading is not.
 *  Here rather than in the API's seats.ts because the boot batch counts billable
 *  seats in SQL, and a role list spelled out twice is a role list that drifts. */
export const BILLABLE_ROLES: readonly Role[] = ["editor", "owner"]
export const isBillableRole = (role: Role): boolean =>
  (BILLABLE_ROLES as readonly string[]).includes(role)

/** The v2 access model's three single-purpose fields (docs/access-model.md).
 *  They live in this leaf alongside Role so BOTH ./ports (record shapes) and
 *  ./permissions (effectiveRole) can name them without an import cycle. */

/** The WORLD link: what anyone merely holding the artifact's URL gets — a
 *  non-member, the public, an anonymous visitor. `none` = the link is inert
 *  (invite-/member-only). A teammate with the link is NOT this — that's
 *  `workspace_access` (they open at their seat role). Anonymous holders are always
 *  clamped to `viewer` regardless of the grant. */
export type LinkRole = "none" | "viewer" | "commenter" | "editor"
/** Whether the artifact's workspace gets access. `member` = every signed-in member
 *  of the artifact's workspace opens at their OWN seat role (owner → manage …
 *  commenter → comment); `none` = the workspace has no standing (only explicit
 *  shares and the world link apply). There is no per-doc workspace role. */
export type WorkspaceAccess = "none" | "member"
/** Discovery only — where the artifact surfaces in feeds. Carries NO access: `none`
 *  (nowhere), `workspace` (the workspace library), `public` (the public directory).
 *  Listing preconditions live at the write path, not here. */
export type Listed = "none" | "workspace" | "public"
