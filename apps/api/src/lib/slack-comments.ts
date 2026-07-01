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
import { parseMeta } from "./comments"
import { decryptSecret } from "./crypto"
import { isPermanentSlackError, joinSlackChannel, postSlackMessage, SlackApiError } from "./slack"

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

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
  const link = `${baseUrl.replace(/\/$/, "")}/a/${artifact.short_id}?c=${encodeURIComponent(cm.thread_id)}`
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
const blocksFor = (p: SlackCommentPayload): unknown => {
  const head = `:speech_balloon: *${p.author}* commented on <${p.link}|${p.title}>`
  const lines = [head, truncate(p.text, 600)]
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Derive · reply in this thread to post back" }],
    },
  ]
}

/** Build the slack_app delivery sender for a runtime. Resolves the channel + thread from
 *  the stored install + thread link, posts via chat.postMessage, and records the Slack
 *  message ts for a new thread so future replies thread under it. No-ops (delivered) when
 *  Slack isn't connected so a row never dead-letters on a tier without Slack. */
export const makeSlackSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackCommentPayload
    const install = await meta.getSlackInstall(p.orgId)
    if (!install?.default_channel || !encryptionKey)
      return { ok: true, status: "skipped: slack not connected" }
    const token = decryptSecret(install.bot_token, encryptionKey)
    const existing = await meta.getSlackThreadLinkByThread(p.threadId)
    const channel = existing?.channel ?? install.default_channel
    const post = () =>
      postSlackMessage(token, {
        channel,
        text: `${p.author} commented on ${p.title}`,
        blocks: blocksFor(p),
        threadTs: existing?.message_ts,
      })

    let res: Awaited<ReturnType<typeof post>>
    try {
      res = await post()
    } catch (err) {
      if (!(err instanceof SlackApiError))
        return { ok: false, status: (err as Error).message.slice(0, 160) }
      // The bot isn't in the channel yet (common right after connecting): auto-join a
      // public channel and retry once. Private channels must invite the bot manually.
      if (err.code === "not_in_channel" && (await joinSlackChannel(token, channel))) {
        try {
          res = await post()
        } catch (err2) {
          const code = err2 instanceof SlackApiError ? err2.code : "unknown"
          return { ok: false, status: `slack: ${code}`, permanent: isPermanentSlackError(code) }
        }
      } else {
        // not_in_channel without a successful join is permanent (a private channel the
        // bot can't self-join) — surface it rather than retrying fruitlessly.
        const permanent = isPermanentSlackError(err.code) || err.code === "not_in_channel"
        return { ok: false, status: `slack: ${err.code}`, permanent }
      }
    }

    // First post for this Derive thread → remember the Slack message so replies thread
    // under it (both directions).
    if (!existing) {
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
    return { ok: true, status: `posted ${res.ts}` }
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
