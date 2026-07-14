// Per-user Slack DMs: the same "email is for interrupts" policy as notify-email.ts
// (mentions, review requests, shares — see that file's header), mirrored onto Slack.
// The Slack user is resolved live from the recipient's Derive account email via
// users.lookupByEmail (see lib/slack.ts resolveSlackUserIdByEmail) — no per-user OAuth or
// account-linking step, just the workspace's one bot install. Rides the same durable
// outbox as the comment mirror (a `slack_dm` delivery kind). Self-host clean: no new env,
// no scheduler — a DM is enqueued inline with the triggering action and delivered by the
// outbox.

import {
  type ArtifactRecord,
  artifactUrl,
  type CommentRecord,
  type DeliveryRecord,
  type MetaStore,
} from "@derive/core"
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

/** Whether a user wants Slack DMs for interrupts (mentions, review requests, shares —
 *  default on). Stored in their per-workspace notification prefs so a user can turn it
 *  off, independent of the workspace-level `emailNotifications` gate email uses. */
export const wantsSlackDm = (prefsJson: string | undefined): boolean => {
  if (!prefsJson) return true
  try {
    return (JSON.parse(prefsJson) as { slackDm?: boolean }).slackDm !== false
  } catch {
    return true
  }
}

const title = (a: ArtifactRecord) => a.title ?? a.short_id

/** Enqueue a DM to each mentioned Derive user who's still a member of the workspace and
 *  hasn't turned Slack DMs off. Resolution to a Slack account happens later, at delivery
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
  const t = title(artifact)
  const seen = new Set<string>()
  for (const m of mentions) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    if (!(await meta.getMembership(artifact.org_id, m.id))) continue // no longer a member
    const pref = await meta.getUserNotificationPref(artifact.org_id, m.id)
    if (!wantsSlackDm(pref?.prefs)) continue
    const blocks = [
      section(`:wave: *${cm.author}* mentioned you on <${link}|${t}>`),
      section(`> ${truncate(cm.body_md, 600)}`),
      actions([openButton(link)]),
    ]
    await enqueueChannelDelivery(meta, "slack_dm", "comment.mention", {
      orgId: artifact.org_id,
      userId: m.id,
      text: `${cm.author} mentioned you on ${t}`,
      blocks,
    } satisfies SlackDmPayload)
  }
}

/** DM the human a review is blocked on — the one event that most deserves to interrupt
 *  (same rationale as buildReviewEmail): the loop is waiting on them and they may have no
 *  tab open. Never for your own request on yourself; caller already enforces that. */
export const enqueueSlackReviewRequestedDm = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  proposal: { requestedBy: string; version: number; note?: string | null },
  reviewerId: string,
): Promise<void> => {
  const { meta, baseUrl } = deps
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install) return
  const pref = await meta.getUserNotificationPref(artifact.org_id, reviewerId)
  if (!wantsSlackDm(pref?.prefs)) return
  const link = artifactUrl(baseUrl, artifact)
  const t = title(artifact)
  const blocks = [
    section(
      `:mag: *${proposal.requestedBy}* requested your review of <${link}|${t}> (v${proposal.version}).`,
    ),
    ...(proposal.note ? [section(`> ${truncate(proposal.note, 600)}`)] : []),
    actions([openButton(link, "Review in Derive")]),
  ]
  await enqueueChannelDelivery(meta, "slack_dm", "review.requested", {
    orgId: artifact.org_id,
    userId: reviewerId,
    text: `${proposal.requestedBy} requested your review of ${t} (v${proposal.version})`,
    blocks,
  } satisfies SlackDmPayload)
}

/** DM the person an artifact was just shared with — deliberate and personal, so it clears
 *  the interrupt bar (same rationale as buildShareEmail): it may be their first contact
 *  with the workspace, and a bell alone can sit unseen. Never for sharing with yourself. */
export const enqueueSlackShareDm = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  input: { sharedBy: string; role: string },
  recipientId: string,
): Promise<void> => {
  const { meta, baseUrl } = deps
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install) return
  const pref = await meta.getUserNotificationPref(artifact.org_id, recipientId)
  if (!wantsSlackDm(pref?.prefs)) return
  const link = artifactUrl(baseUrl, artifact)
  const t = title(artifact)
  const roleSuffix = input.role === "viewer" ? "" : ` as ${input.role}`
  const blocks = [
    section(`:open_file_folder: *${input.sharedBy}* shared <${link}|${t}> with you${roleSuffix}.`),
    actions([openButton(link)]),
  ]
  await enqueueChannelDelivery(meta, "slack_dm", "artifact.shared", {
    orgId: artifact.org_id,
    userId: recipientId,
    text: `${input.sharedBy} shared ${t} with you`,
    blocks,
  } satisfies SlackDmPayload)
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

    // Prefer the reliable account link (the user linked their Slack identity); fall back to
    // guessing by account email only for users who haven't linked — so a Derive email that
    // differs from the Slack email no longer silently drops the DM. (A linked user whose Slack
    // account was later deactivated retries then dead-letters rather than falling back to email
    // — rare, and re-linking or unlinking fixes it.)
    let slackUserId: string | null = null
    const link = await meta.getSlackUserLinkByUser(bot.install.team_id, p.userId)
    if (link) {
      slackUserId = link.slack_user_id
    } else {
      const [user] = await meta.getUsers([p.userId])
      if (!user?.email) return { ok: true, status: "skipped: not linked, no email on file" }
      try {
        slackUserId = await resolveSlackUserIdByEmail(bot.token, user.email)
      } catch (err) {
        return slackFailure(meta, p.orgId, err)
      }
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
