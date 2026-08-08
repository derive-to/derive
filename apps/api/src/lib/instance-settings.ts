/**
 * SETTINGS THAT BELONG TO THE DEPLOY, not to any workspace.
 *
 * Which model answers is the clearest case: the operator holds the credential and pays for
 * every turn on it, so it is their call and not a tenant's.
 *
 * Stored as an ordinary `org_settings` row under a RESERVED key. That table is `org_id TEXT
 * PRIMARY KEY` with a JSON blob and no foreign key to a workspace — identical on sqlite, Postgres
 * and D1 — so this needs no migration on any of the three, and it inherits the same parse,
 * defaulting and upsert the workspace settings already use. The alternative was a new table in
 * three schemas for one string.
 *
 * The key cannot collide with a real workspace: those are minted as `ws_…` (see newId), and this
 * is deliberately not a valid id shape. Nothing enumerates settings rows to build a workspace
 * list — workspaces come from the `org` table — so the reserved row never surfaces as a tenant.
 *
 * 🚨 THE ROW IS ONLY AS PRIVILEGED AS THE ROUTES THAT REACH IT. It now holds the whole model
 * library, so a tenant route that could address it by id would be a privilege escalation and not
 * a stray toggle. Two things keep that shut and BOTH are deliberate: every reader here is behind
 * an operator gate, and `activeWorkspace` refuses to resolve the reserved id at all
 * (context.ts), so no workspace-scoped route can be pointed at it by a cookie. Do not remove
 * either one on the grounds that the other exists.
 */
export const INSTANCE_SETTINGS_ID = "__instance__"
