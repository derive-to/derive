import { createHmac, randomUUID } from "node:crypto"
import { lookup } from "node:dns/promises"
import type { ArtifactRecord, DeliveryRecord, MetaStore } from "@dock/core"
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
      url: `${baseUrl}/a/${artifact.short_id}`,
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

/** Deliver one outbox row. Slack kind sends a Slack message; generic sends the
 *  signed normalized payload. Returns ok + a short status for the delivery log. */
export async function deliverOnce(d: DeliveryRecord): Promise<{ ok: boolean; status: string }> {
  try {
    const payload = JSON.parse(d.payload) as EventPayload
    const isSlack = d.kind === "slack"
    const body = JSON.stringify(isSlack ? slackMessage(payload) : payload)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "dock-webhooks/1",
      "x-dock-event": d.event_type,
    }
    if (!isSlack) headers["x-dock-signature"] = sign(d.secret, body)
    // Re-validate the target at delivery, not just at registration: a hostname
    // that was public when the webhook was created can be rebinded to an internal
    // IP (169.254.169.254 / RFC1918 / loopback) by delivery time (DNS rebinding).
    // Resolve every address and refuse if any is private. (Undici re-resolves on
    // the fetch below, leaving a sub-second TOCTOU window; pinning to the
    // validated IP — which needs an SNI-preserving dispatcher — is the follow-up.)
    let addrs: { address: string }[]
    try {
      addrs = await lookup(new URL(d.url).hostname, { all: true })
    } catch {
      return { ok: false, status: "dns lookup failed" }
    }
    if (addrs.some((a) => isPrivateAddress(a.address)))
      return { ok: false, status: "blocked: resolves to a private address" }
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

/** Find webhooks subscribed to this event for the artifact and enqueue a row each. */
export async function enqueueForEvent(
  meta: MetaStore,
  baseUrl: string,
  artifact: ArtifactRecord,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const hooks = await meta.activeWebhooks(artifact.id, artifact.org_id)
  if (hooks.length === 0) return
  const subscribed = hooks.filter((h) => h.events === "*" || h.events.split(",").includes(event))
  if (subscribed.length === 0) return
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
}

const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts)

/**
 * One outbox pass: atomically claim due deliveries, deliver each, record the
 * result (delivered / retry-with-backoff / dead-letter). The claim increments
 * attempts and leases the rows, so this is safe to run concurrently across
 * instances and from a Worker cron — no row is delivered twice.
 */
export async function runDeliveryTick(meta: MetaStore, limit = 20): Promise<void> {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()
  const due = await meta.claimDueDeliveries(now.toISOString(), limit, leaseUntil)
  for (const d of due) {
    const r = await deliverOnce(d)
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
}

/** The Node outbox worker: run a delivery tick on an interval. Returns a stop fn. */
export function startWebhookWorker(meta: MetaStore, intervalMs = 1500): () => void {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      await runDeliveryTick(meta)
    } catch (err) {
      // A bad tick must not kill the loop, but it must not vanish either —
      // otherwise a persistently failing outbox is invisible.
      log.error("webhook delivery tick failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const timer = setInterval(tick, intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
