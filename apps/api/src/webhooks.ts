import { createHmac, randomUUID } from "node:crypto"
import {
  type ArtifactRecord,
  artifactUrl,
  type DeliveryKind,
  type DeliveryRecord,
  INTERNAL_DELIVERY,
  type MetaStore,
} from "@dock/core"
import type { WebhookEvent } from "./events"
import { isPrivateAddress } from "./lib/net"
import { log } from "./log"

// Event names live in one place (./events) so the webhook list and the bus list
// can't drift apart. Re-exported here for existing importers.
export { WEBHOOK_EVENTS, type WebhookEvent } from "./events"

const MAX_ATTEMPTS = 6
const BASE_BACKOFF_MS = 3_000
const MAX_BACKOFF_MS = 60 * 60_000
// A claimed delivery is leased this long: hidden from other workers/ticks until it
// finishes or the lease lapses (crash recovery). Must exceed a single delivery's
// timeout so an in-flight delivery is never re-claimed.
const CLAIM_LEASE_MS = 60_000
const DELIVER_TIMEOUT_MS = 15_000

/**
 * The one runtime-specific seam in webhook delivery: deciding whether a target
 * URL is safe to deliver to *at delivery time*. The rest of the outbox (claim,
 * deliver, retry, dead-letter) is identical on every runtime, so this is injected
 * rather than hardcoded — keeping webhooks.ts free of `node:dns` so it can be
 * bundled into the Workers/Durable-Object tier.
 *
 * Returns a short failure status when the URL must NOT be delivered to, else null.
 */
export interface AddressGuard {
  precheck(url: string): Promise<string | null>
}

/**
 * Edge guard (Workers / Durable Objects). DNS isn't available, but it isn't needed:
 * Cloudflare's egress refuses subrequests to private / loopback / link-local space
 * and the metadata endpoint, so DNS-rebinding to an internal IP can't land. We only
 * reject literal private IPs in the URL itself (cheap, synchronous defense in depth).
 * The full resolve-and-recheck lives in the Node guard, where DNS exists.
 */
export const edgeGuard: AddressGuard = {
  async precheck(url) {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return "invalid url"
    }
    return isPrivateAddress(host) ? "blocked: resolves to a private address" : null
  },
}

/** Normalized payload stored in the outbox (canonical, re-deliverable). */
export interface EventPayload {
  event: WebhookEvent
  at: string
  artifact: { short_id: string; title: string | null; url: string }
  data: Record<string, unknown>
}

export function buildPayload(
  baseUrl: string,
  artifact: ArtifactRecord,
  event: WebhookEvent,
  data: Record<string, unknown>,
): EventPayload {
  return {
    event,
    at: new Date().toISOString(),
    artifact: {
      short_id: artifact.short_id,
      title: artifact.title,
      url: artifactUrl(baseUrl, artifact),
    },
    data,
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Format a normalized payload as a Slack incoming-webhook message. */
export function slackMessage(p: EventPayload): unknown {
  const title = p.artifact.title ?? p.artifact.short_id
  const link = `<${p.artifact.url}|${title}>`
  let head = ""
  const lines: string[] = []
  if (p.event === "comment.created") {
    const author = String(p.data.author ?? "someone")
    head = `:speech_balloon: *${author}* commented on ${link}`
    if (p.data.quote) lines.push(`> _${truncate(String(p.data.quote), 140)}_`)
    if (p.data.body) lines.push(truncate(String(p.data.body), 280))
  } else if (p.event === "comment.mention") {
    const author = String(p.data.author ?? "someone")
    const who = Array.isArray(p.data.mentioned) ? (p.data.mentioned as string[]).join(", ") : ""
    head = `:wave: *${author}* mentioned ${who ? `*${who}*` : "you"} on ${link}`
    if (p.data.quote) lines.push(`> _${truncate(String(p.data.quote), 140)}_`)
    if (p.data.body) lines.push(truncate(String(p.data.body), 280))
  } else if (p.event === "comment.resolved") {
    head = `:white_check_mark: A thread was ${p.data.state === "open" ? "reopened" : "resolved"} on ${link}`
  } else {
    head = `:package: ${link} — *v${p.data.version}* published`
    if (p.data.message) lines.push(truncate(String(p.data.message), 200))
    if (p.data.author) lines.push(`by ${p.data.author}`)
  }
  return {
    text: head,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: [head, ...lines].join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Dock · ${p.event}` }] },
    ],
  }
}

/** HMAC-SHA256 of the request body, hex. Header: X-Dock-Signature: sha256=… */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

/**
 * Standard Webhooks (standardwebhooks.com) signature. The signed content is
 * `{id}.{timestamp}.{body}` and the header is `webhook-signature: v1,<base64 sig>`,
 * paired with `webhook-id` and `webhook-timestamp`. The key is the secret with any
 * `whsec_` prefix stripped, base64-decoded — exactly how the standardwebhooks
 * verifier libraries derive it, so a consumer can verify Dock with an off-the-shelf
 * library (passing the same secret string) instead of hand-rolling HMAC. We send this
 * alongside the legacy `X-Dock-Signature` header, so existing consumers keep working.
 */
export function standardWebhookSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")
  return `v1,${sig}`
}

/** The result of one delivery attempt: ok ⇒ delivered; otherwise `status` is the
 *  short failure reason recorded on the row (and retried / dead-lettered). */
export interface ChannelSendResult {
  ok: boolean
  status: string
}

/**
 * Senders for the first-party channel kinds (email / connected Slack App / GitHub PR
 * comments). Each runtime (edge Worker, Node self-host) wires the ones it can serve
 * from its own bindings/secrets; `deliverOnce` calls the matching one by `kind`. A
 * kind with no registered sender on this runtime is treated as delivered-no-op (so it
 * doesn't dead-letter forever on a tier that can't serve it — e.g. email with no
 * Email Service binding). The HTTP kinds (`generic`/`slack`) never go through here.
 */
export type ChannelSenders = Partial<
  Record<Exclude<DeliveryKind, "generic">, (d: DeliveryRecord) => Promise<ChannelSendResult>>
>

/** Deliver one outbox row. `generic`/`slack` POST to a configured webhook URL (signed
 *  payload / Slack incoming-webhook message); the first-party channel kinds are handed
 *  to the matching `ChannelSenders` entry. The `guard` re-validates the target host for
 *  SSRF at delivery time on the HTTP path (Node resolves DNS; the edge trusts
 *  Cloudflare's egress isolation). Returns ok + a short status for the delivery log. */
export async function deliverOnce(
  d: DeliveryRecord,
  guard: AddressGuard,
  senders: ChannelSenders = {},
): Promise<ChannelSendResult> {
  // First-party channels (email/slack_app/github_*) carry no configured webhook row;
  // their sender builds credentials + destination from the payload at delivery time.
  if (d.kind !== "generic" && d.kind !== "slack") {
    const send = senders[d.kind]
    if (!send) return { ok: true, status: "skipped: no sender for kind on this runtime" }
    try {
      return await send(d)
    } catch (err) {
      return { ok: false, status: (err as Error).message.slice(0, 200) }
    }
  }
  try {
    const payload = JSON.parse(d.payload) as EventPayload
    const isSlack = d.kind === "slack"
    const body = JSON.stringify(isSlack ? slackMessage(payload) : payload)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "dock-webhooks/1",
      "x-dock-event": d.event_type,
    }
    if (!isSlack) {
      // Sign two ways: the legacy `X-Dock-Signature` (sha256=hex over the body) for
      // existing consumers, and Standard Webhooks headers so new consumers can verify
      // with an off-the-shelf library. `webhook-id` is the (unique) delivery id, which
      // also gives consumers a natural idempotency key for at-least-once delivery.
      headers["x-dock-signature"] = sign(d.secret, body)
      const ts = Math.floor(Date.now() / 1000).toString()
      headers["webhook-id"] = d.id
      headers["webhook-timestamp"] = ts
      headers["webhook-signature"] = standardWebhookSignature(d.secret, d.id, ts, body)
    }
    // Re-validate the target at delivery, not just at registration: a hostname that
    // was public when the webhook was created can be rebound to an internal IP
    // (169.254.169.254 / RFC1918 / loopback) by delivery time (DNS rebinding). The
    // guard is runtime-specific — Node resolves and rejects any private address; the
    // edge relies on Cloudflare refusing private-space subrequests (see AddressGuard).
    const blocked = await guard.precheck(d.url)
    if (blocked) return { ok: false, status: blocked }
    // Do NOT follow redirects: the URL was SSRF-checked at registration, but a
    // 302 to 169.254.169.254 / localhost would bypass that. A redirect is a
    // delivery failure here.
    const res = await fetch(d.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      // Bound a single delivery so a hung endpoint can't pin the worker (and stays
      // well under the claim lease, so the row is never re-claimed mid-delivery).
      signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
    })
    if (res.ok) return { ok: true, status: String(res.status) }
    if (res.status >= 300 && res.status < 400)
      return { ok: false, status: `HTTP ${res.status} (redirect not followed)` }
    return { ok: false, status: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: (err as Error).message.slice(0, 200) }
  }
}

/** Find webhooks subscribed to this event for the artifact and enqueue a row each.
 *  Returns the number of deliveries enqueued, so the caller can skip poking an idle
 *  edge drainer when nothing was queued. */
export async function enqueueForEvent(
  meta: MetaStore,
  baseUrl: string,
  artifact: ArtifactRecord,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<number> {
  const hooks = await meta.activeWebhooks(artifact.id, artifact.org_id)
  if (hooks.length === 0) return 0
  const subscribed = hooks.filter((h) => h.events === "*" || h.events.split(",").includes(event))
  if (subscribed.length === 0) return 0
  const payload = JSON.stringify(buildPayload(baseUrl, artifact, event, data))
  await Promise.all(
    subscribed.map((h) =>
      meta.enqueueDelivery({
        id: `wd_${randomUUID().slice(0, 12)}`,
        webhook_id: h.id,
        url: h.url,
        secret: h.secret,
        kind: h.kind,
        event_type: event,
        payload,
      }),
    ),
  )
  return subscribed.length
}

/** Enqueue one first-party channel delivery (email / Slack App / GitHub PR comment).
 *  Not tied to a configured `webhook` row, so it carries the `INTERNAL_DELIVERY`
 *  sentinel as `webhook_id`. `payload` is a self-contained JSON the matching sender
 *  reads; `url`/`secret` are unused by channel senders (left empty). */
export async function enqueueChannelDelivery(
  meta: MetaStore,
  kind: Exclude<DeliveryKind, "generic" | "slack">,
  event: string,
  payload: unknown,
): Promise<void> {
  await meta.enqueueDelivery({
    id: `wd_${randomUUID().slice(0, 12)}`,
    webhook_id: INTERNAL_DELIVERY,
    url: "",
    secret: "",
    kind,
    event_type: event,
    payload: JSON.stringify(payload),
  })
}

const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts)

/**
 * One outbox pass: atomically claim due deliveries, deliver each, record the
 * result (delivered / retry-with-backoff / dead-letter). The claim increments
 * attempts and leases the rows, so this is safe to run concurrently across
 * instances and from a Worker cron — no row is delivered twice. Returns the number
 * of rows claimed this pass, so a Durable-Object driver can keep ticking while the
 * outbox is busy and go idle when it drains.
 */
export async function runDeliveryTick(
  meta: MetaStore,
  guard: AddressGuard,
  senders: ChannelSenders = {},
  limit = 20,
): Promise<number> {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()
  const due = await meta.claimDueDeliveries(now.toISOString(), limit, leaseUntil)
  for (const d of due) {
    const r = await deliverOnce(d, guard, senders)
    const attempts = d.attempts // already incremented by the claim
    if (r.ok) {
      await meta.updateDelivery(d.id, {
        status: "delivered",
        attempts,
        last_error: null,
        next_attempt_at: d.next_attempt_at,
      })
    } else if (attempts >= MAX_ATTEMPTS) {
      await meta.updateDelivery(d.id, {
        status: "dead",
        attempts,
        last_error: r.status,
        next_attempt_at: d.next_attempt_at,
      })
    } else {
      const next = new Date(Date.now() + backoff(attempts)).toISOString()
      await meta.updateDelivery(d.id, {
        status: "pending",
        attempts,
        last_error: r.status,
        next_attempt_at: next,
      })
    }
  }
  return due.length
}

/** Drives the Node outbox: `stop` halts the loop for graceful shutdown; `poke` drains
 *  the outbox immediately (called right after an event is enqueued) so delivery is
 *  near-instant instead of waiting for the next interval tick. */
export interface WebhookWorker {
  stop: () => void
  poke: () => void
}

/**
 * The Node/self-host outbox driver: an in-process interval that runs a delivery tick,
 * plus a `poke` that drains on demand. The interval is the retry + crash-recovery
 * backstop; `poke` (wired to the enqueue path) is what makes a fresh event go out
 * immediately. A `running` flag coalesces an interval tick and a burst of pokes into
 * one in-flight drain — the leased claim already makes overlap safe, this just avoids
 * redundant passes. This is the self-host counterpart to the edge `WebhookOutbox` DO;
 * both share the same `runDeliveryTick` core, so delivery behaves identically.
 */
export function startWebhookWorker(
  meta: MetaStore,
  guard: AddressGuard,
  senders: ChannelSenders = {},
  intervalMs = 1500,
): WebhookWorker {
  let stopped = false
  let running = false
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      await runDeliveryTick(meta, guard, senders)
    } catch (err) {
      // A bad tick must not kill the loop, but it must not vanish either —
      // otherwise a persistently failing outbox is invisible.
      log.error("webhook delivery tick failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    poke: () => void tick(),
  }
}
