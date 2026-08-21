// Which Slack channels should hear about one event.
//
// Replaces the single `slack_install.default_channel`: a workspace subscribes any number of
// channels, each scoped (whole workspace, or one collection) and filtered by event type and by
// whether the author was a human or an agent.
//
// The author filter is the axis specific to Derive. Agents are first-class authors here — their
// comments and publishes reach Slack like anyone's — so a channel usually wants one or the
// other: #eng-review wants the humans, #agent-log wants the machines.

import type { ArtifactRecord, MetaStore, SlackSubscriptionRecord } from "@derive/core"
import type { WebhookEvent } from "../events"

/** Every event a channel subscription can carry. The single source for the API's enum and the
 *  Settings picker, so the two can't drift the way the webhook event list did. `comment.created`
 *  is here because it reaches a channel too — just threaded, via the comment mirror rather than
 *  as a top-level card. */
export const SLACK_SUBSCRIBABLE_EVENTS = [
  "comment.created",
  "version.published",
  // The review round — the loop's most decision-relevant moment. These already reach the
  // reviewer's DM, but until now no CHANNEL could hear that a doc was blocked on someone, which
  // is exactly the fact a team wants ambient. Existing subscriptions are unaffected: `*` picks
  // them up, an explicit list does not, and the Settings picker reads this constant.
  "review.requested",
  "review.sent_back",
] as const satisfies readonly WebhookEvent[]

/** Whether an author id belongs to an agent. Two shapes count: a registered agent row, and the
 *  synthetic `oauth:<client>` id an OAuth grant authors under (lib/oauth-agent.ts), which is
 *  never a row in the agents table. Anything else — including an unknown or absent id — is
 *  treated as human, so a filter can never silently hide human activity. */
export type AuthorKind = "human" | "agent"

export const authorKind = async (
  meta: MetaStore,
  orgId: string,
  authorId: string | null | undefined,
): Promise<AuthorKind> => {
  if (!authorId) return "human"
  if (authorId.startsWith("oauth:")) return "agent"
  return (await meta.listAgents(orgId)).some((a) => a.id === authorId) ? "agent" : "human"
}

/**
 * The active subscriptions that want this event, in this workspace.
 *
 * Keeps the broadcast rule the single channel already enforced: a private draft
 * (`listed === "none"`) never reaches a channel, however it was subscribed. Everything else is
 * subscription config.
 *
 * Ordered cheapest-first — the event mask and author filter are in-memory over a single indexed
 * read, and the collection membership lookup only happens if some surviving subscription
 * actually scopes to one.
 */
export const resolveChannels = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  event: WebhookEvent,
  author: AuthorKind,
): Promise<SlackSubscriptionRecord[]> => {
  if (artifact.listed === "none") return []
  const subs = (await meta.listSlackSubscriptions(artifact.org_id)).filter((s) => s.active === 1)
  if (!subs.length) return []
  const wanted = subs.filter(
    (s) =>
      // Same encoding as webhook.events: "*" or a comma-separated list.
      (s.events === "*" || s.events.split(",").includes(event)) &&
      (s.authors === "all" || s.authors === author),
  )
  if (!wanted.length) return []
  if (!wanted.some((s) => s.scope_kind === "collection")) return wanted
  const collections = new Set(await meta.collectionIdsForArtifact(artifact.id))
  return wanted.filter((s) => s.scope_kind === "workspace" || collections.has(s.scope_id))
}

/** Does this workspace still want anything to do with this channel?
 *
 *  Deleting `slackPost` removed the only kill switch for INBOUND Slack writes — reply-back and
 *  the Resolve button gated on it too. Without this, `/derive unsubscribe` answered "Derive
 *  won't post here" while replies in that channel kept creating Derive comments and the buttons
 *  kept working, because both gate only on a thread link that nothing ever deletes. A
 *  subscription is the switch in both directions. */
export const channelIsSubscribed = async (
  meta: MetaStore,
  orgId: string,
  channelId: string,
): Promise<boolean> =>
  (await meta.listSlackSubscriptions(orgId)).some(
    (s) => s.active === 1 && s.channel_id === channelId,
  )

/** Normalize a requested event list to the stored encoding, the way `routes/webhooks.ts` does:
 *  omitted means "no filter" (`"*"`), and anything else is the recognized subset — which may be
 *  EMPTY, meaning nothing matches.
 *
 *  Empty must not become `"*"`. It used to: unticking the last checkbox in Settings sent `[]`,
 *  which fell into the same branch as "unspecified" and silently subscribed the channel to
 *  everything — every box came back ticked and the channel started receiving all five events.
 *  An unrecognized name did the same. Fail closed in both cases; a subscription that matches
 *  nothing is a paused one, which is what the user asked for. */
export const subscribableEvents = (events?: string[]): string => {
  if (!events) return "*"
  const kept = [...new Set(events)].filter((e): e is (typeof SLACK_SUBSCRIBABLE_EVENTS)[number] =>
    (SLACK_SUBSCRIBABLE_EVENTS as readonly string[]).includes(e),
  )
  // Deduped before the count compare, so five copies of one event can't look like "all of them".
  return kept.length === SLACK_SUBSCRIBABLE_EVENTS.length ? "*" : kept.join(",")
}
