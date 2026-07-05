// Per-user Slack DMs: when a comment @mentions a Derive user who has linked their Slack
// account and left DMs on, the bot direct-messages them. Rides the same durable outbox as
// the channel posts (a `slack_dm` delivery kind). Self-host clean: no new env, no
// scheduler — a DM is enqueued inline with the mention fan-out and delivered by the outbox.

import type { ArtifactRecord, CommentRecord, DeliveryRecord, MetaStore } from "@derive/core"
import type { ChannelSendResult } from "../webhooks"
import { enqueueChannelDelivery } from "../webhooks"
import { commentDeepLink, type Mention } from "./comments"
import { decryptSecret } from "./crypto"
import {
  isPermanentSlackError,
  isSlackAuthError,
  openSlackDm,
  postSlackMessage,
  SlackApiError,
} from "./slack"
import { flagSlackReauth } from "./slack-events"
import { truncate } from "./text"

/** The self-contained payload a slack_dm delivery carries. */
interface SlackDmPayload {
  orgId: string
  userId: string
  text: string
  blocks: unknown[]
}

/** Whether a user wants Slack DMs when they're @mentioned (default on). Stored in their
 *  per-workspace notification prefs so a user can turn it off. */
export const wantsMentionDm = (prefsJson: string | undefined): boolean => {
  if (!prefsJson) return true
  try {
    return (JSON.parse(prefsJson) as { slackMentionDm?: boolean }).slackMentionDm !== false
  } catch {
    return true
  }
}

const mentionBlocks = (author: string, title: string, body: string, link: string): unknown[] => [
  {
    type: "section",
    text: { type: "mrkdwn", text: `:wave: *${author}* mentioned you on <${link}|${title}>` },
  },
  { type: "section", text: { type: "mrkdwn", text: `> ${truncate(body, 600)}` } },
  {
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: "Open in Derive" }, url: link }],
  },
]

/** Enqueue a DM to each mentioned Derive user who has a confirmed Slack link, is still a
 *  member of the workspace, and hasn't turned mention DMs off. A confirmed link is only
 *  created by a signed-in member (via the account-link OAuth), so this reaches teammates,
 *  never strangers — the same trust boundary the bell-notification gate enforces. */
export const enqueueSlackMentionDms = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  cm: CommentRecord,
  mentions: Mention[],
): Promise<void> => {
  const { meta, baseUrl } = deps
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install) return
  const link = commentDeepLink(baseUrl, artifact, cm.thread_id)
  const title = artifact.title ?? artifact.short_id
  const seen = new Set<string>()
  for (const m of mentions) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const userLink = await meta.getSlackUserLinkByUser(artifact.org_id, m.id)
    if (userLink?.status !== "confirmed") continue
    if (!(await meta.getMembership(artifact.org_id, m.id))) continue // no longer a member
    const pref = await meta.getUserNotificationPref(artifact.org_id, m.id)
    if (!wantsMentionDm(pref?.prefs)) continue
    const payload: SlackDmPayload = {
      orgId: artifact.org_id,
      userId: m.id,
      text: `${cm.author} mentioned you on ${title}`,
      blocks: mentionBlocks(cm.author, title, cm.body_md, link),
    }
    await enqueueChannelDelivery(meta, "slack_dm", "comment.mention", payload)
  }
}

/** Enqueue an arbitrary DM to a Derive user (used by the "send test DM" button). */
export const enqueueSlackDm = async (
  meta: MetaStore,
  orgId: string,
  userId: string,
  text: string,
  blocks: unknown[],
): Promise<void> => {
  await enqueueChannelDelivery(meta, "slack_dm", "dm", {
    orgId,
    userId,
    blocks,
    text,
  } satisfies SlackDmPayload)
}

/** Build the slack_dm delivery sender: resolve the user's linked Slack id, open (or reuse)
 *  their DM channel, post. Caches the opened IM channel on the link. No-ops (delivered)
 *  when the user isn't linked or Slack isn't connected, so a row never dead-letters. */
export const makeSlackDmSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackDmPayload
    const install = await meta.getSlackInstall(p.orgId)
    const userLink = await meta.getSlackUserLinkByUser(p.orgId, p.userId)
    if (!install || !encryptionKey || userLink?.status !== "confirmed")
      return { ok: true, status: "skipped: user not linked" }
    const token = decryptSecret(install.bot_token, encryptionKey)
    try {
      const channel = userLink.dm_channel_id ?? (await openSlackDm(token, userLink.slack_user_id))
      if (!userLink.dm_channel_id)
        await meta.setSlackUserLink({ ...userLink, dm_channel_id: channel })
      const res = await postSlackMessage(token, { channel, text: p.text, blocks: p.blocks })
      return { ok: true, status: `dm ${res.ts}` }
    } catch (err) {
      if (!(err instanceof SlackApiError))
        return { ok: false, status: (err as Error).message.slice(0, 160) }
      if (isSlackAuthError(err.code)) await flagSlackReauth(meta, p.orgId)
      return { ok: false, status: `slack: ${err.code}`, permanent: isPermanentSlackError(err.code) }
    }
  }
