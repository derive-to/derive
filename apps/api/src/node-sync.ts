import type { BlobStore, MetaStore } from "@derive/core"
import { isSyncing, runToCompletion } from "./lib/sync-runner"
import { log } from "./log"

/**
 * Node / self-host counterpart to the `RepoSyncRunner` Durable Object: drives a
 * triggered GitHub sync to completion in-process, detached from the HTTP request, so
 * it survives the user navigating away (same UX + tab-independence as the edge tier,
 * where the DO does this). The web UI polls the persisted `progress` either way.
 *
 * `start(sourceId)` kicks a background batch-loop (deduped, so a double "Sync now" or
 * a webhook + manual trigger don't run two loops for one source). `resumeStalled()`
 * re-launches any source left mid-sync — called on boot (a process restart mid-sync)
 * and on a short interval (a self-heal backstop, mirroring the edge cron), made
 * idempotent by the persisted file-map. The Worker can't run loops like this, so this
 * module is Node-only (imported solely by node.ts, like webhooks-node.ts).
 */
export function createNodeSyncRunner(
  meta: MetaStore,
  blobs: BlobStore,
  encryptionKey: string | undefined,
) {
  // Sources with a loop in flight, so a re-trigger (or the resume sweep) never starts
  // a second loop for the same source. The detached loop clears its own entry.
  const inFlight = new Set<string>()

  const start = (sourceId: string): void => {
    if (inFlight.has(sourceId)) return
    inFlight.add(sourceId)
    // Detached: never awaited, so the HTTP handler that triggered it returns at once.
    void runToCompletion(meta, blobs, encryptionKey, sourceId)
      .catch((err) =>
        // runSync already persisted phase="error" for the UI; this only logs the
        // loop giving up so a self-host operator sees it.
        log.error("node sync runner failed", {
          source: sourceId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => inFlight.delete(sourceId))
  }

  // Re-launch every source whose persisted progress says it's mid-sync but has no loop
  // running here (e.g. the process restarted). The file-map makes resume idempotent —
  // already-synced docs are skipped, so this never re-creates or duplicates artifacts.
  const resumeStalled = async (): Promise<void> => {
    try {
      const sources = await meta.listSyncingRepoSources()
      const stalled = sources.filter((s) => isSyncing(s) && !inFlight.has(s.id))
      if (stalled.length) log.info("resuming stalled syncs", { count: stalled.length })
      for (const s of stalled) start(s.id)
    } catch (err) {
      log.error("resume stalled syncs failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { start, resumeStalled }
}
