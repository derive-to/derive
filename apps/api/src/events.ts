// Single source of truth for event names.
//
// `DOMAIN_EVENTS` is everything the system emits on the in-process bus (the SSE
// fan-out). `WEBHOOK_EVENTS` is the outbound-relevant subset. Both derive from
// the lists here, and the compile-time check at the bottom proves the webhook
// list is a subset of the domain list — so the two can never silently diverge
// the way two independent enums did before. Add an event in ONE place.

const DOMAIN_EVENTS = [
  "comment.created",
  "comment.mention",
  "comment.resolved",
  "comment.outdated",
  "comment.reacted",
  "comment.updated",
  "version.published",
  "review.requested",
  "review.sent_back",
  "presence",
  "cursor",
  "notification",
  // An agent pushed to the user's workspace — emitted on the user's `u:<id>`
  // channel so their open tabs can auto-open the artifact. Not webhook-eligible
  // (it is a per-user UI signal, like `notification`).
  "artifact.pushed",
  // A request landed in an agent's pull inbox (an @mention of that agent) —
  // emitted on the agent's `u:<id>` channel so a session long-polling
  // check_requests({wait}) wakes at once instead of on its next reconnect. A
  // wake signal only (the handler re-reads the inbox); not webhook-eligible.
  "request.created",
  // A session reached a terminal turn — the runner answered (answered/escalated),
  // the run crashed (failed), or the asker/owner ended it (closed). Emitted on
  // the ASKER's `u:<id>` channel so an MCP use({wait}) long-poll wakes at once.
  // A wake signal only (waiters re-read the session); not webhook-eligible.
  "session.settled",
  // A long-running (Maker) session posted PROGRESS without settling — the runner
  // is still working. Emitted on the ASKER's `u:<id>` channel so use({wait})
  // returns the tick instead of blocking to timeout. A wake only (the waiter
  // re-reads the transcript); the session stays `working`; not webhook-eligible.
  "session.progress",
  // A slice of the answer being written, for a reply the model is streaming. Emitted
  // on the ASKER's `u:<id>` channel with `session_id`, a monotonic `seq`, `text`, and the
  // `attempt` it belongs to — a reply the loop re-generates starts a new attempt, and a reader
  // must REPLACE on one rather than append (see lib/session-stream.ts).
  //
  // UNLIKE ITS SIBLINGS THIS ONE CARRIES CONTENT rather than being a bare wake — which
  // is the point, since re-reading is the round trip streaming exists to avoid. It is
  // still not authoritative: deltas are coalesced, may be dropped, and are never
  // persisted. The transcript written when the turn settles is the record, so a client
  // that misses deltas loses the animation and nothing else. Not webhook-eligible —
  // partial text is not something anyone can act on.
  "session.delta",
] as const
export type DomainEvent = (typeof DOMAIN_EVENTS)[number]

/** The subset of domain events a webhook can subscribe to (no presence/notification). */
export const WEBHOOK_EVENTS = [
  "comment.created",
  "comment.mention",
  "comment.resolved",
  "version.published",
  "review.requested",
  "review.sent_back",
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

// Guardrail: every webhook event must be a real domain event. If someone adds a
// name to WEBHOOK_EVENTS that isn't in DOMAIN_EVENTS (a typo, or a webhook-only
// event the bus doesn't know about), this assignment stops compiling.
type WebhookIsSubsetOfDomain = WebhookEvent extends DomainEvent ? true : never
const _webhookSubset: WebhookIsSubsetOfDomain = true
void _webhookSubset
