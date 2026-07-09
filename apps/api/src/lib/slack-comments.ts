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
import { type ChannelSendResult, enqueueChannelDelivery } from "../webhooks"
import { commentDeepLink, type Mention, parseMeta } from "./comments"
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

/** Resolve `<@U…>` user mentions in a Slack message to the Derive users they're linked to
 *  in this workspace (confirmed links only). Returns Mentions the shared notifier can fan
 *  out — so @mentioning a linked teammate in a Slack thread notifies them in Derive. */
export const resolveSlackMentions = async (
  meta: MetaStore,
  orgId: string,
  text: string,
): Promise<Mention[]> => {
  const seen = new Set<string>()
  const out: Mention[] = []
  for (const m of text.matchAll(/<@([A-Z0-9]+)>/g)) {
    const slackId = m[1]
    if (!slackId || seen.has(slackId)) continue
    seen.add(slackId)
    const link = await meta.getSlackUserLinkBySlackId(orgId, slackId)
    if (link?.status !== "confirmed") continue
    const [user] = await meta.getUsers([link.user_id])
    out.push({ id: link.user_id, name: user?.name ?? user?.username ?? "someone" })
  }
  return out
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

  const id = newId("c")
  const created = await meta.createComment({
    id,
    artifact_id: link.artifact_id,
    thread_id: link.thread_id,
    base_version: 0, // a reply inherits the thread; base_version isn't meaningful here
    path: null,
    anchor: null,
    body_md: args.text,
    author: args.userName,
    author_id: `slack:${args.userId}`,
  })
  const patched = await meta.updateComment(created.id, {
    meta: JSON.stringify({ slack: { ts: args.ts, channel: link.channel } }),
  })
  return patched ?? created
}
