// Outbound Slack posts for the connected app's richer events (version.published,
// proposal.*, review.*, comment.resolved) — the counterpart to slack-comments.ts, which
// owns the comment thread mirror. Both ride the same durable outbox (webhook_delivery).
// This subscribes to the notify() event stream: notify() calls enqueueSlackEvent for
// every workspace with a connected Slack App, and makeSlackEventSender renders + posts
// the card at delivery time.

import type { ArtifactRecord, DeliveryRecord, MetaStore } from "@derive/core"
import { artifactUrl } from "@derive/core"
import type { WebhookEvent } from "../events"
import type { ChannelSendResult } from "../webhooks"
import { enqueueChannelDelivery } from "../webhooks"
import { type CardInput, cardForEvent, isThreadedEvent } from "./slack-cards"
import { postWithRecovery, resolveBotToken } from "./slack-delivery"

/** The self-contained payload an enqueued slack_app_event delivery carries. */
export interface SlackEventPayload {
  orgId: string
  artifactId: string
  event: WebhookEvent
  artifact: { short_id: string; title: string | null; url: string }
  data: Record<string, unknown>
}

/** Comment created/mention are mirrored as Slack threads by slack-comments.ts; the event
 *  sender never posts them (that would double-post). Everything else in WEBHOOK_EVENTS is
 *  fair game, gated per workspace by the slackEvents toggle map. */
const MIRRORED_BY_COMMENTS = new Set<WebhookEvent>(["comment.created", "comment.mention"])

/** Enqueue a Slack event post for a workspace with a connected app, unless the event is
 *  handled by the comment mirror or turned off in settings. Returns whether a row was
 *  enqueued so the caller can poke the drainer. Best-effort: any store hiccup just skips. */
export const enqueueSlackEvent = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<boolean> => {
  const { meta, baseUrl } = deps
  if (MIRRORED_BY_COMMENTS.has(event)) return false
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install?.default_channel) return false
  const settings = await meta.getOrgSettings(artifact.org_id)
  if (settings.slackEvents?.[event] === false) return false // explicit opt-out
  const payload: SlackEventPayload = {
    orgId: artifact.org_id,
    artifactId: artifact.id,
    event,
    artifact: {
      short_id: artifact.short_id,
      title: artifact.title,
      url: artifactUrl(baseUrl, artifact),
    },
    data,
  }
  await enqueueChannelDelivery(meta, "slack_app_event", event, payload)
  return true
}

/** Resolve the Slack channel a top-level event card posts to. A per-collection route (for
 *  a collection the artifact belongs to) wins; else a configured `default` route; else the
 *  workspace's install default channel. No routes ⇒ fast path, no artifact→collection query. */
export const resolveSlackChannel = async (
  meta: MetaStore,
  orgId: string,
  artifactId: string,
  defaultChannel: string,
): Promise<string> => {
  const routes = await meta.listSlackChannelRoutes(orgId)
  if (routes.length === 0) return defaultChannel
  const collectionIds = await meta.collectionIdsForArtifact(artifactId)
  const collectionIdSet = new Set(collectionIds)
  const collectionRoute = routes.find(
    (r) => r.target_type === "collection" && collectionIdSet.has(r.target_id),
  )
  if (collectionRoute) return collectionRoute.channel_id
  const defaultRoute = routes.find((r) => r.target_type === "default")
  return defaultRoute?.channel_id ?? defaultChannel
}

/** Build the slack_app_event delivery sender: render the card, resolve channel + threading,
 *  post via chat.postMessage. No-ops (delivered) when Slack isn't connected so a row never
 *  dead-letters on a tier/workspace without Slack. */
export const makeSlackEventSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackEventPayload
    const bot = await resolveBotToken(meta, p.orgId, encryptionKey)
    if (!bot?.install.default_channel) return { ok: true, status: "skipped: slack not connected" }

    const card = cardForEvent(p as CardInput)
    if (!card) return { ok: true, status: `skipped: no card for ${p.event}` }

    // Threading: comment.resolved posts under the Slack message that mirrors its thread
    // (when one exists); a resolution with no mirrored thread is skipped rather than posted
    // as context-free noise. Everything else posts top-level to the routed/default channel.
    let channel = await resolveSlackChannel(
      meta,
      p.orgId,
      p.artifactId,
      bot.install.default_channel,
    )
    let threadTs: string | undefined
    if (isThreadedEvent(p.event)) {
      const threadId = typeof p.data.thread_id === "string" ? p.data.thread_id : null
      const linkRow = threadId ? await meta.getSlackThreadLinkByThread(threadId) : null
      if (!linkRow) return { ok: true, status: "skipped: thread not mirrored" }
      channel = linkRow.channel
      threadTs = linkRow.message_ts
    }

    return postWithRecovery(
      meta,
      p.orgId,
      bot.token,
      { channel, text: card.text, blocks: card.blocks, threadTs },
      { autoJoin: true, textFallback: true },
    )
  }
