// Single source of truth for event names.
//
// `DOMAIN_EVENTS` is everything the system emits on the in-process bus (the SSE
// fan-out). `WEBHOOK_EVENTS` is the outbound-relevant subset. Both derive from
// the lists here, and the compile-time check at the bottom proves the webhook
// list is a subset of the domain list — so the two can never silently diverge
// the way two independent enums did before. Add an event in ONE place.

export const DOMAIN_EVENTS = [
  "comment.created",
  "comment.mention",
  "comment.resolved",
  "comment.outdated",
  "comment.addressed",
  "comment.reacted",
  "comment.updated",
  "version.published",
  "proposal.created",
  "proposal.approved",
  "proposal.changes_requested",
  "review.requested",
  "review.sent_back",
  "review.approved",
  "presence",
  "cursor",
  "notification",
] as const
export type DomainEvent = (typeof DOMAIN_EVENTS)[number]

/** The subset of domain events a webhook can subscribe to (no presence/notification). */
export const WEBHOOK_EVENTS = [
  "comment.created",
  "comment.mention",
  "comment.resolved",
  "version.published",
  "proposal.created",
  "proposal.approved",
  "proposal.changes_requested",
  "review.requested",
  "review.sent_back",
  "review.approved",
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

// Guardrail: every webhook event must be a real domain event. If someone adds a
// name to WEBHOOK_EVENTS that isn't in DOMAIN_EVENTS (a typo, or a webhook-only
// event the bus doesn't know about), this assignment stops compiling.
type WebhookIsSubsetOfDomain = WebhookEvent extends DomainEvent ? true : never
const _webhookSubset: WebhookIsSubsetOfDomain = true
void _webhookSubset
