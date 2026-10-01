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
  // A mini-app interaction changed one persistent JSON collection. The value is
  // authoritative state (not identity/activity, which stays comment-gated).
  "artifact.state.updated",
  // A dynamic table or figure slot of one version changed (or was deleted) without a
  // new version. A wake signal only: it carries the slot name, kind, version and new
  // revision (null on delete), and the host refetches the value it can see. Not
  // webhook-eligible yet; the version-bump webhook remains the published record.
  "artifact.dynamic.updated",
  "presence",
  "cursor",
  "notification",
  // An agent pushed to the user's workspace — emitted on the user's `u:<id>`
  // channel so their open tabs can auto-open the artifact. Not webhook-eligible
  // (it is a per-user UI signal, like `notification`).
  "artifact.pushed",
  // A request landed in an agent's pull inbox (an @mention of that agent) —
  // emitted on the agent's `u:<id>` channel so a session long-polling
  // catch_up({wait}) wakes at once instead of on its next reconnect. A
  // wake signal only (the handler re-reads the inbox); not webhook-eligible.
  "request.created",
  // THE AGENT MODEL's wake signals (lib/jobs.ts). `job.queued` lands on the AGENT's `u:<id>`
  // channel so a runner long-polling `pull` wakes at once; the other three land on the
  // ASKER's channel so an `ask({wait})` or an open page follows the job. Wakes only, except
  // `job.delta`, which carries a slice of a reply being streamed (lib/session-stream.ts
  // coalesces them; a reader replaces on a new `attempt`). Deltas are never the record: the
  // transcript written when the job settles is. None of these are webhook-eligible.
  "job.queued",
  "job.progress",
  "job.settled",
  "job.delta",
  // A machine took a queued job (queued to running), on the ASKER's channel, so a page that
  // follows it stops saying it waits. A wake only; ask({wait}) does not return on it.
  "job.started",
  // A job reached a person: it waits on someone (`job.needs_you`) or it is over
  // (`job.finished`: succeeded, failed, lost, or cancelled; a retryable failure that goes
  // back in the queue is neither). Emitted once per transition by lib/notify-job.ts on each
  // recipient's `u:<id>` channel, beside the bell row, email, Slack DM, and webhook.
  "job.needs_you",
  "job.finished",
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
  "job.needs_you",
  "job.finished",
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

// Guardrail: every webhook event must be a real domain event. If someone adds a
// name to WEBHOOK_EVENTS that isn't in DOMAIN_EVENTS (a typo, or a webhook-only
// event the bus doesn't know about), this assignment stops compiling.
type WebhookIsSubsetOfDomain = WebhookEvent extends DomainEvent ? true : never
const _webhookSubset: WebhookIsSubsetOfDomain = true
void _webhookSubset
