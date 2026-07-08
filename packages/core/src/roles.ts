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

/** The roles general access (a shared link) can grant a reacher: view-only or comment.
 *  A strict subset of Role — general access never hands out editor/owner. */
export type GeneralRole = "viewer" | "commenter"
