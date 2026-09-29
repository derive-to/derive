import { type MetaStore, Recent } from "@derive/core"

/**
 * A workspace's stored bytes, for its storage cap. Counting them is two aggregate queries:
 * a publish counts live before it stores, but an edit save (someone is waiting on "Saved")
 * checks against the count last taken in this process, at most ten minutes old, and every
 * edit save recounts after its response. Where there is no count yet, the save lands and
 * its recount follows. So an edit save can land at most one save's bytes past the cap
 * before the next one is refused.
 */
export const storageUsage = (meta: Pick<MetaStore, "storageBytes" | "assetStorageBytes">) => {
  const FRESH_MS = 10 * 60_000
  const seen = new Recent<string, { bytes: number; at: number }>(1000)
  const count = async (orgId: string): Promise<number> => {
    const [stored, assets] = await Promise.all([
      meta.storageBytes(orgId),
      meta.assetStorageBytes(orgId),
    ])
    return stored + assets
  }
  return {
    count,
    /** Would `incoming` bytes pass `cap`, by the last count (none: no)? */
    overLastCount: (orgId: string, incoming: number, cap: number | null | undefined): boolean => {
      const last = seen.get(orgId)
      return !!cap && !!last && Date.now() - last.at <= FRESH_MS && last.bytes + incoming > cap
    },
    recount: async (orgId: string): Promise<void> => {
      seen.set(orgId, { bytes: await count(orgId), at: Date.now() })
    },
  }
}
