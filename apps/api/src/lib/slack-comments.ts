// Derive ↔ Slack comment sync over the connected Slack App. Outbound: a Derive comment is
// posted to the workspace's Slack channel via chat.postMessage, threaded under the Slack
// message for that Derive thread (the first comment in a thread starts the Slack thread).
// Inbound: a reply in that Slack thread becomes a Derive comment reply. Loop prevention:
// outbound is skipped for comments that came from Slack (meta.slack); inbound skips our
// own bot's messages.

import type { DeliveryRecord } from "@derive/core"
import {
  type ArtifactRecord,
  type CommentRecord,
  type MetaStore,
  newId,
  type SlackThreadLinkRecord,
} from "@derive/core"
import type { EventBus } from "../bus"
import { type ChannelSendResult, enqueueChannelDelivery } from "../webhooks"
import { commentDeepLink, parseMeta } from "./comments"
import { slackUserName } from "./slack"
import { context, section } from "./slack-cards"
import { postWithRecovery, resolveBotToken } from "./slack-delivery"
import { truncate } from "./text"

/** The Slack message payload an enqueued slack_app delivery carries (self-contained). */
interface SlackCommentPayload {
  orgId: string
  artifactId: string
  threadId: string
  text: string
  link: string
  title: string
  author: string
}

/** Enqueue a Slack post for a Derive comment, unless the comment came FROM Slack or there's
 *  no connected Slack workspace. The delivery sender resolves the channel + threading. */
export const enqueueSlackComment = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  cm: CommentRecord,
): Promise<void> => {
  const { meta, baseUrl } = deps
  if (parseMeta(cm.meta).slack) return // came from Slack — don't echo back
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install?.default_channel) return
  const link = commentDeepLink(baseUrl, artifact, cm.thread_id)
  const payload: SlackCommentPayload = {
    orgId: artifact.org_id,
    artifactId: artifact.id,
    threadId: cm.thread_id,
    text: cm.body_md,
    link,
    title: artifact.title ?? artifact.short_id,
    author: cm.author,
  }
  await enqueueChannelDelivery(meta, "slack_app", "comment.created", payload)
}

/** Slack Block Kit blocks for a comment post. */
const blocksFor = (p: SlackCommentPayload): unknown[] => [
  section(
    `:speech_balloon: *${p.author}* commented on <${p.link}|${p.title}>\n${truncate(p.text, 600)}`,
  ),
  context("Derive · reply in this thread to post back"),
]

/** Build the slack_app delivery sender for a runtime. Resolves the channel + thread from
 *  the stored install + thread link, posts via chat.postMessage, and records the Slack
 *  message ts for a new thread so future replies thread under it. No-ops (delivered) when
 *  Slack isn't connected so a row never dead-letters on a tier without Slack. */
export const makeSlackSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackCommentPayload
    const bot = await resolveBotToken(meta, p.orgId, encryptionKey)
    if (!bot?.install.default_channel) return { ok: true, status: "skipped: slack not connected" }
    const existing = await meta.getSlackThreadLinkByThread(p.threadId)
    const channel = existing?.channel ?? bot.install.default_channel

    const res = await postWithRecovery(
      meta,
      p.orgId,
      bot.token,
      {
        channel,
        text: `${p.author} commented on ${p.title}`,
        blocks: blocksFor(p),
        threadTs: existing?.message_ts,
      },
      { autoJoin: true },
    )
    // First post for this Derive thread → remember the Slack message so replies thread
    // under it (both directions).
    if (res.ok && !existing && res.ts && res.channel) {
      await meta.setSlackThreadLink({
        id: newId("stl"),
        org_id: p.orgId,
        artifact_id: p.artifactId,
        thread_id: p.threadId,
        channel: res.channel,
        message_ts: res.ts,
        created_at: new Date().toISOString(),
      } satisfies SlackThreadLinkRecord)
    }
    return res
  }

/** The inbound Slack thread reply an enqueued slack_ingest delivery carries. Self-contained:
 *  the sender re-resolves the org + thread from the channel + thread ts on the worker. */
interface SlackIngestPayload {
  channel: string
  threadTs: string
  userId: string
  text: string
  ts: string
}

/** Defer a Slack thread reply for ingestion into Derive via the outbox. The events endpoint
 *  calls this after a cheap thread-link check, so the slow part (users.info + the comment
 *  write) runs on the worker: the endpoint acks Slack under its 3s deadline, and a transient
 *  failure is retried by the outbox instead of silently dropping the reply. */
export const enqueueSlackReplyIngest = async (
  meta: MetaStore,
  p: SlackIngestPayload,
): Promise<void> => {
  await enqueueChannelDelivery(meta, "slack_ingest", "slack.reply", p)
}

/** Build the slack_ingest sender: mirror a deferred Slack thread reply into a Derive comment.
 *  Resolves the thread link + install from the payload, fetches the author's display name,
 *  and writes the comment via ingestSlackReply (idempotent on the Slack message ts, so a
 *  redelivery is a no-op). Publishes comment.created on the bus when given one, so a live
 *  viewer sees it (Node runs the worker in-process; the edge has no cross-isolate bus here).
 *  No-ops (delivered) when the thread link/install is gone or the channel mirror is off, so
 *  a stale event never dead-letters. */
export const makeSlackIngestSender =
  (meta: MetaStore, encryptionKey: string | undefined, bus?: Pick<EventBus, "publish">) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackIngestPayload
    const link = await meta.getSlackThreadLinkByTs(p.channel, p.threadTs)
    if (!link) return { ok: true, status: "skipped: no thread link" }
    if (!(await meta.getOrgSettings(link.org_id)).slackPost)
      return { ok: true, status: "skipped: channel mirror off" }
    const bot = await resolveBotToken(meta, link.org_id, encryptionKey)
    if (!bot) return { ok: true, status: "skipped: slack not connected" }
    const name = await slackUserName(bot.token, p.userId)
    const created = await ingestSlackReply(meta, link, {
      ts: p.ts,
      userId: p.userId,
      userName: name,
      text: p.text,
      botUserId: bot.install.bot_user_id,
    })
    if (created) bus?.publish(created.artifact_id, { type: "comment.created" })
    return { ok: true, status: created ? "ingested" : "skipped: own or duplicate" }
  }

/** Mirror a Slack thread reply into Derive as a comment on the linked thread. Returns the
 *  created comment, or null when it should be skipped (our own bot, or no thread link).
 *  `botUserId` is the connected app's bot so we never re-ingest our own posts. */
export const ingestSlackReply = async (
  meta: MetaStore,
  link: SlackThreadLinkRecord,
  args: { ts: string; userId: string; userName: string; text: string; botUserId: string | null },
): Promise<CommentRecord | null> => {
  if (args.botUserId && args.userId === args.botUserId) return null // our own post
  // Dedupe on the Slack message ts (re-deliveries / retries).
  const existing = await meta.listComments(link.artifact_id)
  if (existing.some((c) => parseMeta(c.meta).slack?.ts === args.ts)) return null

  // Write the Slack origin marker atomically WITH the row (not a second updateComment): the
  // outbox can re-claim a leased slack_ingest delivery after a crash, and a marker written
  // in a follow-up write would be invisible to that retry's dedupe scan → a duplicate comment.
  return meta.createComment({
    id: newId("c"),
    artifact_id: link.artifact_id,
    thread_id: link.thread_id,
    base_version: 0, // a reply inherits the thread; base_version isn't meaningful here
    path: null,
    anchor: null,
    body_md: args.text,
    author: args.userName,
    author_id: `slack:${args.userId}`,
    meta: JSON.stringify({ slack: { ts: args.ts, channel: link.channel } }),
  })
}
