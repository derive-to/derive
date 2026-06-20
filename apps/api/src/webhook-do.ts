import type { D1Database, DurableObjectState } from "@cloudflare/workers-types"
import { createD1Store } from "@dock/db/d1"
import { cloudflareEmailSender, type SendEmailBinding } from "./email-cf"
import { emailDeliverySender } from "./lib/email"
import { type ChannelSenders, edgeGuard, runDeliveryTick } from "./webhooks"

// While the outbox has work, re-tick on this cadence so a burst drains promptly and
// near-term retries fire on time — mirroring the Node interval worker. When a tick
// claims nothing the DO goes idle (no alarm) and waits for the next `poke` (a freshly
// enqueued event) or the cron backstop (a retry that came due during an idle gap).
const TICK_MS = 1_500
// A poke schedules the first drain almost immediately, so a new event delivers in
// ~this long rather than waiting up to a cron tick.
const POKE_DELAY_MS = 250

/** The env the outbox DO needs: the D1 binding it builds a MetaStore from, plus the
 *  optional Cloudflare Email Service binding + from-address used to deliver email-kind
 *  rows (absent ⇒ email rows are a delivered no-op on this tier). */
export interface WebhookOutboxEnv {
  DB: D1Database
  SEND_EMAIL?: SendEmailBinding
  EMAIL_FROM?: string
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
  private store: ReturnType<typeof createD1Store>
  private senders: ChannelSenders

  constructor(
    private state: DurableObjectState,
    env: WebhookOutboxEnv,
  ) {
    this.store = createD1Store(env.DB)
    // Email delivery for this tier, when the Cloudflare Email Service binding is bound.
    this.senders =
      env.SEND_EMAIL && env.EMAIL_FROM
        ? { email: emailDeliverySender(cloudflareEmailSender(env.SEND_EMAIL, env.EMAIL_FROM)) }
        : {}
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
    try {
      const claimed = await runDeliveryTick(this.store, edgeGuard, this.senders)
      if (claimed > 0) await this.state.storage.setAlarm(Date.now() + TICK_MS)
    } catch {
      await this.state.storage.setAlarm(Date.now() + TICK_MS)
    }
  }
}
