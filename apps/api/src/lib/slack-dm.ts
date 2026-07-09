// Per-user Slack DMs: when a comment @mentions a Derive user who has left DMs on, the bot
// direct-messages them. The Slack user is resolved live from the mentioned user's Derive
// account email via users.lookupByEmail (see lib/slack.ts resolveSlackUserIdByEmail) — no
// per-user OAuth or account-linking step, just the workspace's one bot install. Rides the
// same durable outbox as the channel posts (a `slack_dm` delivery kind). Self-host clean:
// no new env, no scheduler — a DM is enqueued inline with the mention fan-out and delivered
// by the outbox.

import type { ArtifactRecord, CommentRecord, DeliveryRecord, MetaStore } from "@derive/core"
import type { ChannelSendResult } from "../webhooks"
import { enqueueChannelDelivery } from "../webhooks"
import { commentDeepLink, type Mention } from "./comments"
import { openSlackDm, resolveSlackUserIdByEmail } from "./slack"
import { actions, openButton, section } from "./slack-cards"
import { postWithRecovery, resolveBotToken, slackFailure } from "./slack-delivery"
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
  section(`:wave: *${author}* mentioned you on <${link}|${title}>`),
  section(`> ${truncate(body, 600)}`),
  actions([openButton(link)]),
]

/** Enqueue a DM to each mentioned Derive user who's still a member of the workspace and
 *  hasn't turned mention DMs off. Resolution to a Slack account happens later, at delivery
 *  time, by email — so this enqueues for every opted-in member regardless of whether they
 *  turn out to have a matching Slack account (the sender no-ops cleanly if not). */
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

/** Build the slack_dm delivery sender: resolve the recipient's Slack account by email
 *  (users.lookupByEmail against the workspace's bot token), open a DM, post. No-ops
 *  (delivered) when the user has no email on file, no matching Slack account, or Slack
 *  isn't connected, so a row never dead-letters on an unmatched recipient. */
export const makeSlackDmSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackDmPayload
    const bot = await resolveBotToken(meta, p.orgId, encryptionKey)
    if (!bot) return { ok: true, status: "skipped: slack not connected" }
    const [user] = await meta.getUsers([p.userId])
    if (!user?.email) return { ok: true, status: "skipped: no email on file" }

    let slackUserId: string | null
    try {
      slackUserId = await resolveSlackUserIdByEmail(bot.token, user.email)
    } catch (err) {
      return slackFailure(meta, p.orgId, err)
    }
    if (!slackUserId) return { ok: true, status: "skipped: no matching Slack account" }

    let channel: string
    try {
      channel = await openSlackDm(bot.token, slackUserId)
    } catch (err) {
      return slackFailure(meta, p.orgId, err)
    }
    return postWithRecovery(meta, p.orgId, bot.token, { channel, text: p.text, blocks: p.blocks })
  }
