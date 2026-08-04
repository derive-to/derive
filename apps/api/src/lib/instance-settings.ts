import type { MetaStore } from "@derive/core"

/**
 * SETTINGS THAT BELONG TO THE DEPLOY, not to any workspace.
 *
 * Which model answers is the clearest case: the operator holds the credential and pays for every
 * turn on it, so it is their call and not a tenant's. A workspace Admin flipping it would be
 * spending somebody else's key, and during a provider outage the person who needs to move
 * everyone at once is the person who runs the instance.
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
 */
export const INSTANCE_SETTINGS_ID = "__instance__"

/** The deploy-wide model override, or null when the operator has not set one (⇒ the model
 *  configured for the deploy answers, exactly as before this existed). */
export const getInstanceChatModel = async (meta: MetaStore): Promise<string | null> => {
  const s = await meta.getOrgSettings(INSTANCE_SETTINGS_ID).catch(() => null)
  return s?.chatModel?.trim() || null
}

/** Set it, or clear it with null. Read fresh on every turn, so it takes effect on the next
 *  message rather than the next deploy. */
export const setInstanceChatModel = async (
  meta: MetaStore,
  model: string | null,
): Promise<void> => {
  const cur = await meta.getOrgSettings(INSTANCE_SETTINGS_ID)
  await meta.setOrgSettings(INSTANCE_SETTINGS_ID, { ...cur, chatModel: model ?? undefined })
}
