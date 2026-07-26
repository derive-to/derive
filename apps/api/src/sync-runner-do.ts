import type {
  D1Database,
  DurableObjectState,
  Hyperdrive,
  R2Bucket,
} from "@cloudflare/workers-types"
import type { BlobStore } from "@derive/core"
import { R2BlobStore } from "@derive/storage"
import { tickStore } from "./edge-pg"
import { runSourceBatch } from "./lib/sync-runner"
import { log } from "./log"

// While a source still has files to mirror, re-run on this cadence so a large repo
// drains batch-by-batch without any one alarm holding a long-running task (the
// per-batch file cap keeps each tick inside the Workers CPU budget). The engine
// persists its file-map + progress every batch, so the DB row is the source of
// truth and losing the DO only delays the next batch to the cron backstop. Kept
// small: the gap between successful batches is pure latency, not a throttle.
const TICK_MS = 50
// A `/start` poke schedules the first batch almost immediately.
const POKE_DELAY_MS = 200
// A batch that THROWS (a GitHub blip / secondary rate limit mid-mirror) backs off
// before retrying — distinct from TICK_MS so collapsing the success gap doesn't also
// collapse the cooldown a transient error needs. The engine already persisted
// phase="error", so a recovering retry flips it back to mirroring/done.
const RETRY_BACKOFF_MS = 1_200
// Past this many consecutive throws we stop and leave the error visible for the user.
const MAX_RETRIES = 4

/** The env the sync runner DO needs: the datastore bindings for the per-batch
 *  MetaStore (Postgres when HYPERDRIVE is bound, else D1 — see edge-pg.ts) +
 *  R2 (blobs) + the at-rest key. */
export interface RepoSyncRunnerEnv {
  DB: D1Database
  HYPERDRIVE?: Hyperdrive
  BUCKET: R2Bucket
  /** At-rest key for decrypting stored PATs / minting installation tokens. */
  DERIVE_AUTH_SECRET?: string
}

/**
 * Server-side GitHub-sync runner for the Workers tier — one Durable Object instance
 * per source (addressed `idFromName("sync:" + sourceId)`), so a sync runs to
 * completion on OUR servers and survives the user closing the browser tab. It is the
 * edge counterpart to the Node detached loop (`runToCompletion` kicked from node.ts):
 * same bounded-batch engine (`runSourceBatch` → `runSync`), driven by a
 * self-rescheduling alarm instead of an awaited loop, so no single alarm holds a
 * long task.
 *
 * `fetch("/start?source=rs_…")` (poked by the Worker when a sync is triggered) records
 * the source id and arms the alarm; `alarm()` runs ONE batch and reschedules while
 * `remaining > 0`, then goes idle. The engine persists the file-map + a pollable
 * `progress` JSON every batch (the UI's big bar reads it), so the DO holds no
 * authoritative state — a lost instance or missed poke only delays the next batch to
 * the cron backstop, and the persisted map makes every retry idempotent.
 */
export class RepoSyncRunner {
  private blobs: BlobStore
  private key: string | undefined

  constructor(
    private state: DurableObjectState,
    private env: RepoSyncRunnerEnv,
  ) {
    this.blobs = new R2BlobStore(env.BUCKET)
    this.key = env.DERIVE_AUTH_SECRET
  }

  // The Worker pokes this with the source to sync. Persist the id (the alarm has no
  // request context) and arm the alarm when none is pending — an alarm already set
  // fires within a tick. Reset the retry counter so a fresh trigger starts clean.
  async fetch(req: Request): Promise<Response> {
    const sourceId = new URL(req.url).searchParams.get("source")
    if (sourceId) {
      await this.state.storage.put("source", sourceId)
      await this.state.storage.put("retries", 0)
    }
    const pending = await this.state.storage.getAlarm()
    if (pending === null) await this.state.storage.setAlarm(Date.now() + POKE_DELAY_MS)
    return new Response("ok")
  }

  // One bounded batch, then reschedule while work remains so a big repo drains. The
  // alarm must never strand: on a thrown batch, retry with backoff up to MAX_RETRIES
  // (the engine already persisted phase="error"), then stop. On success it reschedules
  // only while `remaining > 0`, so the DO goes idle the moment the repo is fully synced.
  async alarm(): Promise<void> {
    const sourceId = await this.state.storage.get<string>("source")
    if (!sourceId) return // nothing queued (a stray cron/poke) — stay idle
    // Store construction stays inside the try: a throw anywhere must land in the
    // retry/backoff path, or the batch loop strands until the next user trigger.
    let close = async () => {}
    try {
      const opened = tickStore(this.env)
      close = opened.close
      const meta = opened.store
      const source = await meta.getRepoSource(sourceId)
      if (!source) {
        await this.stop() // disconnected mid-sync — nothing left to do
        return
      }
      const res = await runSourceBatch(meta, this.blobs, this.key, source)
      if (res.remaining > 0) {
        await this.state.storage.put("retries", 0)
        await this.state.storage.setAlarm(Date.now() + TICK_MS)
      } else {
        await this.stop() // fully synced — go idle
      }
    } catch (err) {
      const retries = (await this.state.storage.get<number>("retries")) ?? 0
      if (retries >= MAX_RETRIES) {
        log.error("sync runner gave up", {
          source: sourceId,
          error: err instanceof Error ? err.message : String(err),
        })
        await this.stop() // phase="error" is already persisted for the UI
        return
      }
      // Linear backoff; a recovering batch overwrites progress back to mirroring/done.
      await this.state.storage.put("retries", retries + 1)
      await this.state.storage.setAlarm(Date.now() + RETRY_BACKOFF_MS * (retries + 1))
    } finally {
      await close()
    }
  }

  // Clear queued state so a future poke starts fresh and no stale alarm fires.
  private async stop(): Promise<void> {
    await this.state.storage.delete("source")
    await this.state.storage.delete("retries")
    await this.state.storage.deleteAlarm()
  }
}
