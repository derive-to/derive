import type { MetaStore, SearchIndex } from "@derive/core"
import { log } from "../log"
import { deleteArtifactAndUnindex } from "./search"

/**
 * Anonymous drafts — the account-less publish → claim flow (routes/artifacts.ts
 * `/v1/drafts`).
 *
 * A draft is an ordinary artifact with three twists: it lives in the reserved
 * holding workspace below, it has no owner at all (author_id null, no member
 * row — the same state deleteUserData leaves behind), and it carries an
 * `expires_at`. Claiming moves it into a real workspace and clears the expiry;
 * the sweep deletes whatever nobody claimed.
 */

/** The reserved holding workspace every unclaimed draft lives in. A fixed id —
 *  not a config value — so concurrent mints converge on one row via the
 *  setWorkspace upsert (the `ws_p_<user>` personal-workspace precedent). No
 *  human is ever a member; nothing lists it. */
export const DRAFTS_ORG_ID = "ws_sys_drafts"

/** How long an unclaimed draft lives. 72h: survives a weekend, still a real
 *  deadline — the expiry is the conversion prompt. */
export const DRAFT_TTL_MS = 72 * 60 * 60 * 1000

/**
 * Delete expired drafts: their subdomain rows first (so the host 404s rather
 * than dangling), then the artifact via the one sanctioned hard-delete helper
 * (row + FTS + dense vector together). Per-artifact best-effort — one failure
 * must not strand the rest of the sweep. Returns how many were removed.
 *
 * Blob bytes are NOT reclaimed: the store is content-addressed and shared
 * across artifacts, so real GC needs reference counting (a known, deliberate
 * gap — see the BlobStore port).
 */
export const sweepExpiredDrafts = async (
  meta: MetaStore,
  search: Pick<SearchIndex, "unindexArtifact"> | undefined,
  limit = 500,
): Promise<number> => {
  const expired = await meta.listExpiredArtifacts(new Date().toISOString(), limit)
  let removed = 0
  for (const a of expired) {
    try {
      for (const d of await meta.getArtifactDomains(a.id)) await meta.deleteDomain(d.host, d.org_id)
      await deleteArtifactAndUnindex(meta, search, a.id, a.org_id)
      removed++
    } catch (err) {
      log.error("draft sweep failed for artifact", { artifact: a.id, err: String(err) })
    }
  }
  return removed
}
