// Per-user Slack DMs: the same "email is for interrupts" policy as notify-email.ts
// (mentions, review requests, shares — see that file's header), mirrored onto Slack.
// The Slack user is resolved from the account link when the recipient has one, and only
// falls back to guessing by their Derive account email via users.lookupByEmail (see
// lib/slack.ts resolveSlackUserIdByEmail) when they haven't linked. That fallback is
// best-effort: an unmatched email is reported as delivered-but-skipped rather than a
// failure, so a Derive address that differs from the Slack one drops the DM silently —
// linking is what makes delivery reliable. Rides the same durable
// outbox as the comment mirror (a `slack_dm` delivery kind). Self-host clean: no new env,
// no scheduler — a DM is enqueued inline with the triggering action and delivered by the
// outbox.

import {
  type ArtifactRecord,
  artifactUrl,
  type CommentRecord,
  type DeliveryRecord,
  type MetaStore,
  newId,
  type SlackThreadLinkRecord,
} from "@derive/core"
import type { ChannelSendResult } from "../webhooks"
import { enqueueChannelDelivery } from "../webhooks"
import { commentDeepLink, type Mention, previewOf } from "./comments"
import { openSlackDm, resolveSlackUserIdByEmail } from "./slack"
import { actionButton, actions, mrkdwnBody, mrkdwnLabel, openButton, section } from "./slack-cards"
import { postWithRecovery, resolveBotToken, slackFailure } from "./slack-delivery"
import { commentThreadEntity, encodeReviewAction, SLACK_REVIEW_ACTION } from "./slack-work-object"

/** The self-contained payload a slack_dm delivery carries. */
interface SlackDmPayload {
  orgId: string
  userId: string
  text: string
  blocks: unknown[]
  /** Present only for an @mention. It gives the delivery worker enough durable context to make
   *  the first DM a Work Object and to thread every later ping under that one root. */
  mention?: {
    artifactId: string
    artifactShortId: string
    artifactTitle: string | null
    threadId: string
    commentId: string
    author: string
    /** Safe Slack mrkdwn, rendered before writing this durable outbox payload. */
    bodyMrkdwn: string
    link: string
  }
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
  // Slack uses top-level `text` for notifications and assistive technology rather than reading
  // the Block Kit body. Keep a bounded, fully escaped excerpt there as well as on the rich card.
  const fallbackText = `${mrkdwnLabel(cm.author)} mentioned you on ${mrkdwnLabel(t)}: ${mrkdwnLabel(previewOf(cm.body_md), 300)}`
  const seen = new Set<string>()
  for (const m of mentions) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    if (!(await meta.getMembership(artifact.org_id, m.id))) continue // no longer a member
    const pref = await meta.getUserNotificationPref(artifact.org_id, m.id)
    if (!wantsSlackDm(pref?.prefs)) continue
    const blocks = [
      section(`:wave: *${mrkdwnLabel(cm.author)}* mentioned you on <${link}|${mrkdwnLabel(t)}>`),
      section(`> ${mrkdwnBody(cm.body_md, 600)}`),
      actions([openButton(link)]),
    ]
    await enqueueChannelDelivery(meta, "slack_dm", "comment.mention", {
      orgId: artifact.org_id,
      userId: m.id,
      text: fallbackText,
      blocks,
      mention: {
        artifactId: artifact.id,
        artifactShortId: artifact.short_id,
        artifactTitle: artifact.title,
        threadId: cm.thread_id,
        commentId: cm.id,
        author: mrkdwnLabel(cm.author),
        bodyMrkdwn: mrkdwnBody(cm.body_md, 700),
        link,
      },
    } satisfies SlackDmPayload)
  }
}

/**
 * A live-document mention has no canonical comment thread yet, so its Slack DM is
 * deliberately an interrupt with contextual prose and one Open action — never a
 * pseudo-reply surface that cannot be mirrored safely back into Derive.
 */
export const enqueueSlackArtifactMentionDms = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  recipients: Array<{ id: string; excerpt?: string }>,
  input: { author: string; excerpt: string },
): Promise<void> => {
  const { meta, baseUrl } = deps
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install) return
  const link = artifactUrl(baseUrl, artifact)
  const t = title(artifact)
  const seen = new Set<string>()
  for (const recipient of recipients) {
    if (seen.has(recipient.id)) continue
    seen.add(recipient.id)
    const pref = await meta.getUserNotificationPref(artifact.org_id, recipient.id)
    if (!wantsSlackDm(pref?.prefs)) continue
    const excerpt = recipient.excerpt ?? input.excerpt
    const blocks = [
      section(
        `:wave: *${mrkdwnLabel(input.author)}* mentioned you in <${link}|${mrkdwnLabel(t)}>.`,
      ),
      ...(excerpt ? [section(`> ${mrkdwnBody(excerpt, 600)}`)] : []),
      actions([openButton(link)]),
    ]
    await enqueueChannelDelivery(meta, "slack_dm", "artifact.mention", {
      orgId: artifact.org_id,
      userId: recipient.id,
      text: `${mrkdwnLabel(input.author)} mentioned you in ${mrkdwnLabel(t)}: ${mrkdwnLabel(excerpt, 300)}`,
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
  round: { requestedBy: string; version: number; note?: string | null },
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
      `:mag: *${mrkdwnLabel(round.requestedBy)}* requested your review of <${link}|${mrkdwnLabel(t)}> (v${round.version}).`,
    ),
    ...(round.note ? [section(`> ${mrkdwnBody(round.note, 600)}`)] : []),
    // Settle it HERE. This DM is the one moment the loop is blocked on a named person, and it
    // is addressed to exactly them — so the two answers the agent is waiting for belong on it,
    // with "Review in Derive" kept for everything a button cannot express. Sending them to a
    // browser to press the same button is the difference between a notification and a
    // place to work.
    actions([
      actionButton(
        SLACK_REVIEW_ACTION.sendBack,
        "Send back",
        encodeReviewAction(artifact.id),
        "primary",
      ),
      openButton(link, "Review in Derive"),
    ]),
  ]
  await enqueueChannelDelivery(meta, "slack_dm", "review.requested", {
    orgId: artifact.org_id,
    userId: reviewerId,
    text: `${mrkdwnLabel(round.requestedBy)} requested your review of ${mrkdwnLabel(t)} (v${round.version})`,
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
  // input.role is a fixed vocabulary (never user text), so it needs no escaping.
  const roleSuffix = input.role === "viewer" ? "" : ` as ${input.role}`
  const blocks = [
    section(
      `:open_file_folder: *${mrkdwnLabel(input.sharedBy)}* shared <${link}|${mrkdwnLabel(t)}> with you${roleSuffix}.`,
    ),
    actions([openButton(link)]),
  ]
  await enqueueChannelDelivery(meta, "slack_dm", "artifact.shared", {
    orgId: artifact.org_id,
    userId: recipientId,
    text: `${mrkdwnLabel(input.sharedBy)} shared ${mrkdwnLabel(t)} with you`,
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
    // A mention has one personal Slack root per recipient and Derive thread. Re-mentions post
    // compactly beneath it, which preserves a place to reply without repeatedly shoving a large
    // card into someone's DM timeline.
    const existing = p.mention
      ? (await meta.listSlackThreadLinksByThread(p.mention.threadId)).find(
          (l) =>
            l.surface === "mention_dm" &&
            l.recipient_user_id === p.userId &&
            l.channel === channel &&
            l.slack_user_id === slackUserId,
        )
      : undefined
    const blocks =
      existing && p.mention
        ? [
            section(
              `:speech_balloon: *${p.mention.author}* mentioned you again\n> ${p.mention.bodyMrkdwn}`,
            ),
          ]
        : p.blocks
    const metadata =
      p.mention && !existing
        ? {
            entities: [
              commentThreadEntity({
                baseUrl: p.mention.link.replace(/\/artifacts\/.*/, ""),
                artifact: {
                  id: p.mention.artifactId,
                  short_id: p.mention.artifactShortId,
                  title: p.mention.artifactTitle,
                },
                comment: {
                  thread_id: p.mention.threadId,
                  body_md: "",
                  author: p.mention.author,
                  state: "open",
                },
                bodyMrkdwn: p.mention.bodyMrkdwn,
                iconUrl: new URL("/icon.png", p.mention.link).toString(),
              }),
            ],
          }
        : undefined
    const res = await postWithRecovery(
      meta,
      p.orgId,
      bot.token,
      {
        channel,
        text: p.text,
        blocks,
        threadTs: existing?.message_ts,
        metadata,
      },
      { metadataFallback: true },
    )
    if (res.ok && p.mention && !existing && res.ts && res.channel) {
      await meta.setSlackThreadLink({
        id: newId("stl"),
        org_id: p.orgId,
        artifact_id: p.mention.artifactId,
        thread_id: p.mention.threadId,
        channel: res.channel,
        message_ts: res.ts,
        surface: "mention_dm",
        recipient_user_id: p.userId,
        slack_user_id: slackUserId,
        created_at: new Date().toISOString(),
      } satisfies SlackThreadLinkRecord)
    }
    return res
  }
