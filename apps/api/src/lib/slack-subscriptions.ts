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
