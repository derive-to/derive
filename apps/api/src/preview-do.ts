import type { BrowserWorker } from "@cloudflare/puppeteer"
import type {
  D1Database,
  DurableObjectState,
  Hyperdrive,
  R2Bucket,
} from "@cloudflare/workers-types"
import { R2BlobStore } from "@derive/storage"
import { tickStore } from "./edge-pg"
import { runExportTick } from "./exports"
import { log } from "./log"
import { cfBrowserRenderer } from "./preview-cf"
import { runRenderTick, sweepMissingRenders } from "./previews"

// While the render queue has work, re-tick on this cadence so a burst drains
// promptly and near-term retries fire on time — mirroring the webhook outbox.
// When a tick claims nothing the DO goes idle (no alarm) and waits for the
// next poke or the cron backstop.
const TICK_MS = 1_500
// A poke schedules the first drain almost immediately, so a new event delivers
// in ~this long rather than waiting up to a cron tick.
const POKE_DELAY_MS = 250
// Preview deployments have no cron (by design), so one delayed idle probe is the
// bounded backstop for a failed export whose retry is not due on the immediate
// drain tick. It stops after one empty probe instead of polling forever.
const EXPORT_RETRY_PROBE_MS = 60_000
const EXPORT_IDLE_PROBE = "export-idle-probe"

/** The env the render DO needs: datastore bindings (Postgres when HYPERDRIVE is
 *  bound, else D1), the R2 blob bucket, the Browser Rendering binding, and the
 *  optional base URL + sandbox origin + auth secret for minting preview tokens. */
export interface PreviewRendererEnv {
  DB: D1Database
  HYPERDRIVE?: Hyperdrive
  BUCKET: R2Bucket
  BROWSER: BrowserWorker
  BASE_URL?: string
  DERIVE_SANDBOX_URL?: string
  DERIVE_AUTH_SECRET?: string
  /** When true this deployment drains only renderer-scoped export jobs. It must
   *  never sweep or claim ordinary preview jobs from the shared database. */
  DERIVE_EXPORTS_ONLY?: string
}

export const previewRendererWorkMode = (
  env: Pick<PreviewRendererEnv, "DERIVE_EXPORTS_ONLY">,
): "full" | "exports-only" => (env.DERIVE_EXPORTS_ONLY === "true" ? "exports-only" : "full")

export const exportOnlyAlarmDecision = (
  claimed: number,
  idleProbeArmed: boolean,
): { delayMs: number | null; idleProbeArmed: boolean } => {
  if (claimed > 0) return { delayMs: TICK_MS, idleProbeArmed: false }
  if (!idleProbeArmed) return { delayMs: EXPORT_RETRY_PROBE_MS, idleProbeArmed: true }
  return { delayMs: null, idleProbeArmed: false }
}

/**
 * Preview render worker for the Workers tier (a single Durable Object, addressed
 * by a fixed name so every isolate pokes the same instance). It is the edge
 * counterpart to `startPreviewWorker` in previews.ts: same render-tick core,
 * driven by a self-rescheduling alarm instead of setInterval.
 *
 * `poke` (an empty subrequest from the Worker after enqueuing) arms the alarm so
 * a new artifact renders in ~POKE_DELAY_MS; `alarm` runs one tick and keeps the
 * loop alive while the queue is busy. The DB row is the durable source of truth —
 * the DO holds no state, so losing it (or a missed poke) only delays rendering to
 * the next cron backstop.
 *
 * Single-consumer invariant: one fixed name "previews" → one DO instance → one
 * browser at a time → no parallel browser billing.
 */
export class PreviewRenderer {
  constructor(
    private state: DurableObjectState,
    private env: PreviewRendererEnv,
  ) {}

  // The Worker pokes this (and the cron backstop hits it) to wake the drainer.
  // Arm the alarm only when none is pending — an alarm already set will fire
  // within a tick.
  async fetch(_req: Request): Promise<Response> {
    if (previewRendererWorkMode(this.env) === "exports-only") {
      // A fresh export should not wait behind the delayed retry probe.
      await this.state.storage.delete(EXPORT_IDLE_PROBE)
      await this.state.storage.setAlarm(Date.now() + POKE_DELAY_MS)
      return new Response("ok")
    }
    const pending = await this.state.storage.getAlarm()
    if (pending === null) await this.state.storage.setAlarm(Date.now() + POKE_DELAY_MS)
    return new Response("ok")
  }

  // One render pass, then reschedule while there was work so bursts drain and
  // near-term retries fire without waiting for the next poke/cron. Errors must
  // not strand the alarm — on failure, reschedule so the loop self-heals.
  async alarm(): Promise<void> {
    let close = async () => {}
    try {
      const opened = tickStore(this.env)
      close = opened.close
      const blobs = new R2BlobStore(this.env.BUCKET)
      const renderer = cfBrowserRenderer(this.env.BROWSER)
      if (!this.env.BASE_URL)
        log.warn(
          "preview renderer: BASE_URL unset, defaulting to https://derive.to — set BASE_URL for non-prod deploys",
        )
      const baseUrl = this.env.BASE_URL ?? "https://derive.to"
      const deps = {
        meta: opened.store,
        blobs,
        renderer,
        baseUrl,
        sandboxOrigin: this.env.DERIVE_SANDBOX_URL,
        secret: this.env.DERIVE_AUTH_SECRET ?? "",
      }
      let claimed = 0
      if (previewRendererWorkMode(this.env) === "full") {
        // Sweep first so a never-rendered version (pre-pipeline publish, or a path
        // that missed the enqueue) is claimed by the very tick that finds it.
        await sweepMissingRenders(opened.store)
        claimed = await runRenderTick(deps)
      }
      const exportsClaimed = await runExportTick(deps)
      if (previewRendererWorkMode(this.env) === "exports-only") {
        const idleProbe = (await this.state.storage.get<boolean>(EXPORT_IDLE_PROBE)) === true
        const next = exportOnlyAlarmDecision(exportsClaimed, idleProbe)
        if (next.idleProbeArmed) await this.state.storage.put(EXPORT_IDLE_PROBE, true)
        else await this.state.storage.delete(EXPORT_IDLE_PROBE)
        if (next.delayMs !== null) await this.state.storage.setAlarm(Date.now() + next.delayMs)
      } else if (claimed + exportsClaimed > 0) {
        await this.state.storage.setAlarm(Date.now() + TICK_MS)
      }
    } catch {
      await this.state.storage.setAlarm(Date.now() + TICK_MS)
    } finally {
      await close()
    }
  }
}
