import type {
  D1Database,
  DurableObjectState,
  Hyperdrive,
  R2Bucket,
} from "@cloudflare/workers-types"
import type { MetaStore } from "@derive/core"
import { R2BlobStore } from "@derive/storage"
import { tickStore } from "./edge-pg"
import { cloudflareEmailSender, type SendEmailBinding } from "./email-cf"
import { answerDeriveMention } from "./lib/comment-turn"
import { emailDeliverySender } from "./lib/email"
import { catalogFromGateway } from "./lib/model-catalog"
import { modelSource, readLibrary } from "./lib/model-library"
import { makeSlackIngestSender, makeSlackSender } from "./lib/slack-comments"
import { makeSlackDmSender } from "./lib/slack-dm"
import { type ChannelSenders, edgeGuard, runDeliveryTick } from "./webhooks"

// While the outbox has work, re-tick on this cadence so a burst drains promptly and
// near-term retries fire on time — mirroring the Node interval worker. When a tick
// claims nothing the DO goes idle (no alarm) and waits for the next `poke` (a freshly
// enqueued event) or the cron backstop (a retry that came due during an idle gap).
const TICK_MS = 1_500
// A poke schedules the first drain almost immediately, so a new event delivers in
// ~this long rather than waiting up to a cron tick.
const POKE_DELAY_MS = 250

/** The env the outbox DO needs: the datastore bindings it builds a per-tick MetaStore
 *  from (Postgres when HYPERDRIVE is bound, else D1 — see edge-pg.ts), plus the
 *  optional Cloudflare Email Service binding + from-address used to deliver email-kind
 *  rows (absent ⇒ email rows are a delivered no-op on this tier). */
export interface WebhookOutboxEnv {
  DB: D1Database
  HYPERDRIVE?: Hyperdrive
  SEND_EMAIL?: SendEmailBinding
  EMAIL_FROM?: string
  DERIVE_AUTH_SECRET?: string
  // Everything below is for answering an @Derive mention typed in a mirrored Slack thread. A
  // Durable Object receives the SAME script-wide bindings the Worker does; they were simply
  // never declared here, which is why that answer worked on self-host and silently did nothing
  // on the hosted tier. See the slack_ingest sender below.
  BUCKET?: R2Bucket
  BASE_URL?: string
  DERIVE_MODEL_BASE_URL?: string
  DERIVE_MODEL_API_KEY?: string
  DERIVE_MODEL_NAME?: string
  DERIVE_MODEL_NAMES?: string
  DERIVE_MODEL_PROVIDERS?: string
  DERIVE_CHAT_ALLOWLIST?: string
}

/** The @Derive-in-a-thread answerer for this tier, or undefined when the deploy has no model.
 *
 *  Built here rather than injected because the DO is constructed by the runtime, not by the
 *  Worker's request path — there is nowhere to hand it in from. `notify` is a no-op and there is
 *  no bus: the DO is a separate isolate from the SSE handlers (see the sender's own note), so the
 *  answer lands in the database and shows on the reader's next fetch rather than as a live push.
 *  That is the same trade the surrounding ingest already makes. */
const mentionAnswerer = (env: WebhookOutboxEnv, store: MetaStore) => {
  const gw =
    env.DERIVE_MODEL_BASE_URL && env.DERIVE_MODEL_API_KEY && env.DERIVE_MODEL_NAME
      ? {
          baseUrl: env.DERIVE_MODEL_BASE_URL,
          apiKey: env.DERIVE_MODEL_API_KEY,
          model: env.DERIVE_MODEL_NAME,
          alsoModels: env.DERIVE_MODEL_NAMES,
          providers: env.DERIVE_MODEL_PROVIDERS,
        }
      : undefined
  const models = catalogFromGateway(gw)
  if (!models || !env.BUCKET || !env.BASE_URL) return undefined
  return answerDeriveMention({
    meta: store,
    blobs: new R2BlobStore(env.BUCKET),
    bus: { publish: () => {}, subscribe: () => () => {} } as never,
    baseUrl: env.BASE_URL,
    // Per turn, not held: the same operator library the API tier reads (lib/model-library.ts).
    models: modelSource(models, gw, () => readLibrary(store)),
    notify: async () => {},
    chatAllowlist: (env.DERIVE_CHAT_ALLOWLIST ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  })
}

/**
 * Webhook outbox drainer for the Workers tier (a single Durable Object, addressed by
 * a fixed name so every isolate pokes the same instance). It is the edge counterpart
 * to the Node interval worker (`startWebhookWorker`): same outbox table, same
 * claim/deliver/retry/dead-letter core (`runDeliveryTick`), driven by a self-rescheduling
 * alarm instead of `setInterval`. SSRF re-validation uses `edgeGuard` (Cloudflare egress
 * blocks private-space subrequests; no `node:dns` on this tier).
 *
 * `poke` (an empty subrequest from the Worker after enqueuing) arms the alarm so a new
 * event delivers in ~POKE_DELAY_MS; `alarm` runs one tick and keeps the loop alive while
 * the outbox is busy. The DB row is the durable source of truth — the DO holds no state,
 * so losing it (or a missed poke) only delays delivery to the next cron backstop.
 */
export class WebhookOutbox {
  constructor(
    private state: DurableObjectState,
    private env: WebhookOutboxEnv,
  ) {}

  // First-party channel senders for this tier, rebuilt per tick (they capture the
  // tick's store). Email is present when the Cloudflare Email Service binding is bound.
  private senders(store: MetaStore): ChannelSenders {
    const env = this.env
    return {
      ...(env.SEND_EMAIL && env.EMAIL_FROM
        ? {
            email: emailDeliverySender(
              cloudflareEmailSender(env.SEND_EMAIL, env.EMAIL_FROM),
              env.BUCKET ? new R2BlobStore(env.BUCKET) : undefined,
            ),
          }
        : {}),
      slack_app: makeSlackSender(store, env.DERIVE_AUTH_SECRET),
      slack_dm: makeSlackDmSender(store, env.DERIVE_AUTH_SECRET),
      // Inbound Slack thread reply deferred by the events endpoint. No bus here: the DO
      // is a separate isolate from the SSE request handlers, so the comment lands and
      // shows on the viewer's next read rather than a live push.
      // The answerer is threaded in so an @Derive mention typed INSIDE a mirrored thread is
      // answered as a Derive comment — the same turn the web app runs. node.ts has always
      // passed it; this tier never did, so the hosted product quietly ignored those mentions
      // while self-host answered them. A deploy with no model gateway still passes nothing,
      // which stays the honest "nothing answers" state rather than a failure.
      slack_ingest: makeSlackIngestSender(
        store,
        env.DERIVE_AUTH_SECRET,
        undefined,
        mentionAnswerer(env, store),
      ),
    }
  }

  // The Worker pokes this (and the cron backstop hits it) to wake the drainer. Arm the
  // alarm only when none is pending — an alarm already set will fire within a tick.
  async fetch(_req: Request): Promise<Response> {
    const pending = await this.state.storage.getAlarm()
    if (pending === null) await this.state.storage.setAlarm(Date.now() + POKE_DELAY_MS)
    return new Response("ok")
  }

  // One outbox pass, then reschedule while there was work so bursts drain and near-term
  // retries fire without waiting for the next poke/cron. Errors must not strand the
  // alarm — on failure, reschedule so the loop self-heals.
  async alarm(): Promise<void> {
    // Store construction stays inside the try: a throw anywhere must still land in
    // the catch's re-arm, or the drain loop strands until the cron backstop.
    let close = async () => {}
    try {
      const opened = tickStore(this.env)
      close = opened.close
      const claimed = await runDeliveryTick(opened.store, edgeGuard, this.senders(opened.store))
      if (claimed > 0) await this.state.storage.setAlarm(Date.now() + TICK_MS)
    } catch {
      await this.state.storage.setAlarm(Date.now() + TICK_MS)
    } finally {
      await close()
    }
  }
}
