// Derive ↔ Slack comment sync over the connected Slack App. Outbound: a Derive comment is
// posted to the workspace's Slack channel via chat.postMessage, threaded under the Slack
// message for that Derive thread (the first comment in a thread starts the Slack thread).
// Inbound: a reply in that Slack thread becomes a Derive comment reply. Loop prevention:
// outbound is skipped for comments that came from Slack (meta.slack); inbound skips our
// own bot's messages.

import type { DeliveryRecord } from "@derive/core"
import {
  type ArtifactRecord,
  artifactUrl,
  type CommentRecord,
  type MetaStore,
  newId,
  type SlackThreadLinkRecord,
} from "@derive/core"
import type { EventBus } from "../bus"
import type { WebhookEvent } from "../events"
import { type ChannelSendResult, enqueueChannelDelivery } from "../webhooks"
import { commentDeepLink, parseMeta } from "./comments"
import { SlackApiError, slackUserName, updateSlackMessage } from "./slack"
import {
  actionButton,
  actions,
  context,
  escapeMrkdwn,
  mrkdwnBody,
  mrkdwnLabel,
  section,
} from "./slack-cards"
import { postWithRecovery, resolveBotToken, slackFailure } from "./slack-delivery"
import { authorKind, channelIsSubscribed, resolveChannels } from "./slack-subscriptions"

/** The Slack message payload an enqueued slack_app delivery carries (self-contained). */
interface SlackCommentPayload {
  /** The channel this row delivers to. One outbox row per subscribed channel, so a failure in
   *  one channel retries and dead-letters on its own. */
  channel: string
  orgId: string
  artifactId: string
  threadId: string
  text: string
  link: string
  title: string
  author: string
}

/** The payload for a `chat.update` that re-states a mirrored thread's resolved/open state.
 *
 *  Carries everything needed to REBUILD the card rather than a diff, because chat.update
 *  replaces a message's blocks wholesale — there is no partial update. The card fields are the
 *  same ones SlackCommentPayload carries, re-read from the thread's root comment at enqueue
 *  time, so an edited comment re-renders with its current text. */
interface SlackThreadStatePayload {
  channel: string
  /** The Slack message to rewrite — the root card for this (thread, channel). */
  messageTs: string
  orgId: string
  artifactId: string
  threadId: string
  state: "open" | "resolved"
  /** Who acted, for the footer. Undefined when the actor has no display name to show. */
  actor?: string
  text: string
  link: string
  title: string
  author: string
}

/** Bring every mirrored copy of a thread's card in line with the thread's real state.
 *
 *  Fixes two halves of the same gap. Resolving a thread in Derive's UI, over the API or by an
 *  agent used to reach Slack not at all: the card kept offering "Resolve thread" for a thread
 *  that was already closed. And resolving from a BUTTON only rewrote the card in the channel the
 *  click came from (that is all a response_url can address), so a thread mirrored into three
 *  channels left two of them stale.
 *
 *  Both are the same fix — every linked channel gets a chat.update — so this runs on every
 *  resolve, whatever triggered it, including the clicked channel. The click path also repaints
 *  through response_url for instant feedback; that is an optimistic paint and this is the
 *  durable one, so a failed or expired response_url self-heals instead of leaving a stale button
 *  forever. Writing the same blocks twice is visually a no-op.
 *
 *  Returns the number of channels enqueued. */
export const enqueueSlackThreadState = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  threadId: string,
  state: "open" | "resolved",
  actor?: string,
): Promise<number> => {
  const { meta, baseUrl } = deps
  // One indexed lookup keyed on thread_id, and the ONLY cost a workspace with no Slack pays:
  // a thread that was never mirrored has no links and returns here, before anything else is
  // read. Deliberately first for that reason — every resolve in the product runs this.
  const links = await meta.listSlackThreadLinksByThread(threadId)
  if (!links.length) return 0
  // A thread link outlives an unsubscribe, so a channel an admin cut off must not keep watching
  // its cards mutate — same gate the inbound reply path uses. Resolved BEFORE the comment read
  // below so a thread whose channels have all unsubscribed costs nothing further.
  const live: typeof links = []
  for (const l of links)
    if (await channelIsSubscribed(meta, artifact.org_id, l.channel)) live.push(l)
  if (!live.length) return 0
  // The card's section is the thread's FIRST comment — the one the root message was posted for.
  // Later replies in the thread posted as Slack replies underneath it, so they are not what a
  // rewrite of the root should show.
  const root = (await meta.listComments(artifact.id))
    .filter((cm) => cm.thread_id === threadId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  if (!root) return 0
  const link = commentDeepLink(baseUrl, artifact, threadId)
  let n = 0
  for (const l of live) {
    const payload: SlackThreadStatePayload = {
      channel: l.channel,
      messageTs: l.message_ts,
      orgId: artifact.org_id,
      artifactId: artifact.id,
      threadId,
      state,
      ...(actor ? { actor } : {}),
      text: root.body_md,
      link,
      title: artifact.title ?? artifact.short_id,
      author: root.author,
    }
    await enqueueChannelDelivery(meta, "slack_app", "comment.resolved", payload)
    n++
  }
  return n
}

/** Enqueue a Slack post for a Derive comment, unless the comment came FROM Slack or there's
 *  no connected Slack workspace. The delivery sender resolves the channel + threading. */
export const enqueueSlackComment = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  cm: CommentRecord,
): Promise<number> => {
  const { meta, baseUrl } = deps
  if (parseMeta(cm.meta).slack) return 0 // came from Slack — don't echo back
  // resolveChannels keeps the visibility gate (a private draft never reaches a channel) and
  // applies each subscription's event + author filters.
  const channels = await resolveChannels(
    meta,
    artifact,
    "comment.created",
    await authorKind(meta, artifact.org_id, cm.author_id),
  )
  if (!channels.length) return 0
  const link = commentDeepLink(baseUrl, artifact, cm.thread_id)
  for (const sub of channels) {
    const payload: SlackCommentPayload = {
      channel: sub.channel_id,
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
  return channels.length
}

/** The self-contained payload for a channel EVENT card (publish / proposal lifecycle). Carried
 *  on a `slack_app` delivery whose `event_type` is the event — the sender routes on that, so
 *  event cards and the comment mirror share the kind without a payload discriminator. */
interface SlackEventPayload {
  /** As SlackCommentPayload.channel — one row per subscribed channel. */
  channel: string
  orgId: string
  artifactId: string
  event: WebhookEvent
  title: string
  link: string
  author: string
  version: number | null
  message: string | null
  /** The proposal id, for a proposal.created card — carried on its Approve buttons. */
  proposalId: string | null
}

/** The interactivity `action_id`s an in-channel proposal card's buttons carry. */
export const SLACK_PROPOSAL_ACTION = {
  approve: "derive_proposal_approve",
  requestChanges: "derive_proposal_request_changes",
} as const

/** Encode a proposal button's `value`: which proposal on which artifact to act on. */
export const encodeProposalAction = (artifactId: string, proposalId: string): string =>
  JSON.stringify({ a: artifactId, p: proposalId })

/** Decode a proposal button `value` back to its target ids — the inverse of
 *  encodeProposalAction. Tolerant of a malformed/attacker-supplied value (returns null): the
 *  ids only NAME the target, which the handler re-authorizes against the account link, so a
 *  bad value can at worst pick a nonexistent proposal. */
export const decodeProposalAction = (
  value: string,
): { artifactId: string; proposalId: string } | null => {
  try {
    const { a, p } = JSON.parse(value) as { a?: string; p?: string }
    return a && p ? { artifactId: a, proposalId: p } : null
  } catch {
    return null
  }
}

/** Artifact-lifecycle events that post a top-level card to the connected channel (comments
 *  mirror separately + threaded, so they're NOT here). Everything else `notify` fans out to
 *  webhooks only. */
const CHANNEL_EVENTS = new Set<WebhookEvent>([
  "version.published",
  "proposal.created",
  "proposal.approved",
  "proposal.changes_requested",
  "review.requested",
  "review.sent_back",
  "review.approved",
])

/** Enqueue a top-level channel card for an artifact-lifecycle event, when the org has a
 *  matching channel subscription. Returns whether it enqueued (so the
 *  caller can poke the drainer). Cheap no-op for the common case — the event whitelist is
 *  checked before any DB lookup. */
export const enqueueSlackChannelEvent = async (
  meta: MetaStore,
  baseUrl: string,
  artifact: ArtifactRecord,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<boolean> => {
  if (!CHANNEL_EVENTS.has(event)) return false
  // `actor_id` is the stable id of whoever caused this (notify's callers pass it alongside the
  // display name), and is what the human/agent subscription filter keys on.
  const channels = await resolveChannels(
    meta,
    artifact,
    event,
    await authorKind(
      meta,
      artifact.org_id,
      typeof data.actor_id === "string" ? data.actor_id : null,
    ),
  )
  if (!channels.length) return false
  const actor = [data.author, data.approver, data.reviewer].find((v) => typeof v === "string")
  for (const sub of channels) {
    const payload: SlackEventPayload = {
      channel: sub.channel_id,
      orgId: artifact.org_id,
      artifactId: artifact.id,
      event,
      title: artifact.title ?? artifact.short_id,
      link: artifactUrl(baseUrl, artifact),
      author: typeof actor === "string" ? actor : "someone",
      version: typeof data.version === "number" ? data.version : null,
      message: typeof data.message === "string" ? data.message : null,
      proposalId: typeof data.proposal_id === "string" ? data.proposal_id : null,
    }
    await enqueueChannelDelivery(meta, "slack_app", event, payload)
  }
  return true
}

/** Block Kit for a channel event card. Untrusted text (title, author, message) is escaped so
 *  it can't break out of a `<url|text>` link or inject markup. */
const eventBlocks = (p: SlackEventPayload): unknown[] => {
  const link = `<${p.link}|${mrkdwnLabel(p.title)}>`
  const who = mrkdwnLabel(p.author)
  let head: string
  switch (p.event) {
    case "version.published":
      head = `:package: *${link}* — v${p.version ?? "?"} published by ${who}`
      break
    case "proposal.created":
      head = `:pencil2: *${who}* proposed a change to ${link}`
      break
    case "proposal.approved":
      head = `:white_check_mark: A proposal for ${link} was approved${p.version ? ` — now v${p.version}` : ""}`
      break
    case "proposal.changes_requested":
      head = `:leftwards_arrow_with_hook: Changes were requested on a proposal for ${link}`
      break
    // The review round. `who` is the actor — the agent that asked, or the human who answered —
    // so the line names whoever moved it, the same way the proposal cases do.
    case "review.requested":
      head = `:mag: *${who}* asked for a review of ${link}`
      break
    case "review.sent_back":
      head = `:leftwards_arrow_with_hook: *${who}* sent back answers on ${link}`
      break
    case "review.approved":
      head = `:white_check_mark: *${who}* approved ${link}`
      break
    default:
      head = `${link} — ${escapeMrkdwn(p.event)}`
  }
  const body = p.message ? `${head}\n> ${mrkdwnBody(p.message, 280)}` : head
  const blocks: unknown[] = [section(body)]
  // An open proposal gets Approve / Request-changes buttons (the clicker is authorized as
  // their linked Derive user in the interactivity handler).
  if (p.event === "proposal.created" && p.proposalId) {
    const value = encodeProposalAction(p.artifactId, p.proposalId)
    blocks.push(
      actions([
        actionButton(SLACK_PROPOSAL_ACTION.approve, "Approve", value, "primary"),
        actionButton(SLACK_PROPOSAL_ACTION.requestChanges, "Request changes", value),
      ]),
    )
  }
  blocks.push(context(`Derive · ${p.event}`))
  return blocks
}

/** The interactivity `action_id`s a comment card's buttons carry. The handler in
 *  routes/slack.ts dispatches on these; they double as the resolve/reopen intent. */
export const SLACK_THREAD_ACTION = {
  resolve: "derive_thread_resolve",
  reopen: "derive_thread_reopen",
} as const

/** Encode a button's `value`: which thread to act on. Read back by the interactivity
 *  handler (and re-checked against the thread link — the value is ours, but we don't
 *  trust it for authorization, only to name the target). */
export const encodeThreadAction = (artifactId: string, threadId: string): string =>
  JSON.stringify({ a: artifactId, t: threadId })

/** Decode a thread button `value` back to its target ids — the inverse of encodeThreadAction.
 *  Tolerant of a malformed value (returns null); the ids are re-checked against the thread
 *  link before any state change, so they're only a target name, never authorization. */
export const decodeThreadAction = (
  value: string,
): { artifactId: string; threadId: string } | null => {
  try {
    const { a, t } = JSON.parse(value) as { a?: string; t?: string }
    return a && t ? { artifactId: a, threadId: t } : null
  } catch {
    return null
  }
}

/** The action + context blocks under a comment card for a given thread state. Rebuilt by the
 *  interactivity handler after a resolve/reopen (with `who` = the Slack user who acted) and
 *  used for the first post (open, no `who`). `value` is the encoded thread target. */
export const threadStateBlocks = (
  state: "open" | "resolved",
  value: string,
  who?: string,
): unknown[] => {
  // `who` is the acting Slack user's display name (attacker-controllable) landing in a mrkdwn
  // context block — escape it like every other untrusted field so a name can't inject markup.
  const w = who ? mrkdwnLabel(who) : undefined
  return state === "resolved"
    ? [
        actions([actionButton(SLACK_THREAD_ACTION.reopen, "Reopen thread", value)]),
        context(`Derive · :white_check_mark: resolved${w ? ` by ${w}` : ""}`),
      ]
    : [
        actions([actionButton(SLACK_THREAD_ACTION.resolve, "Resolve thread", value, "primary")]),
        context(
          w
            ? `Derive · reopened by ${w} · reply in this thread to post back`
            : "Derive · reply in this thread to post back",
        ),
      ]
}

/** Slack Block Kit blocks for a comment post (open thread, with a Resolve button). Every
 *  untrusted field is neutralized: author + title are labels (`escapeMrkdwn`), and the comment
 *  body is authored prose (`mrkdwnBody` — escaped, then its markdown rendered). They land in a
 *  mrkdwn section, so an unescaped `<!channel>` would ping the channel and a `>` would break
 *  out of the link — same treatment eventBlocks gives its fields. */
const threadSection = (p: { author: string; link: string; title: string; text: string }) =>
  section(
    `:speech_balloon: *${mrkdwnLabel(p.author)}* commented on <${p.link}|${mrkdwnLabel(p.title)}>\n${mrkdwnBody(p.text, 600)}`,
  )

const blocksFor = (p: SlackCommentPayload): unknown[] => [
  threadSection(p),
  ...threadStateBlocks("open", encodeThreadAction(p.artifactId, p.threadId)),
]

/** Build the slack_app delivery sender for a runtime. Resolves the channel + thread from
 *  the stored install + thread link, posts via chat.postMessage, and records the Slack
 *  message ts for a new thread so future replies thread under it. No-ops (delivered) when
 *  Slack isn't connected so a row never dead-letters on a tier without Slack. */
export const makeSlackSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    // A resolve/reopen REWRITES an existing card rather than posting anything, so it branches
    // before the two posting paths. Checked first: it shares the kind with them and would
    // otherwise fall into the event-card branch and post a second, top-level message.
    if (d.event_type === "comment.resolved") {
      const p = JSON.parse(d.payload) as SlackThreadStatePayload
      const bot = await resolveBotToken(meta, p.orgId, encryptionKey)
      if (!bot) return { ok: true, status: "skipped: slack not connected" }
      try {
        await updateSlackMessage(bot.token, {
          channel: p.channel,
          ts: p.messageTs,
          text: `${mrkdwnLabel(p.author)} commented on ${mrkdwnLabel(p.title)}`,
          blocks: [
            threadSection(p),
            ...threadStateBlocks(p.state, encodeThreadAction(p.artifactId, p.threadId), p.actor),
          ],
        })
        return { ok: true, status: `updated ${p.messageTs}` }
      } catch (err) {
        // message_not_found means the card was deleted in Slack — the thread link points at
        // nothing, and retrying can never succeed. Report delivered-but-skipped so the row
        // doesn't burn its retries and dead-letter over a message someone tidied away.
        if (err instanceof SlackApiError && err.code === "message_not_found")
          return { ok: true, status: "skipped: message deleted" }
        return slackFailure(meta, p.orgId, err)
      }
    }
    // Event cards (publish / proposal lifecycle) ride the same kind but a different event_type,
    // and post top-level (not threaded under an artifact's comment message).
    if (d.event_type !== "comment.created") {
      const e = JSON.parse(d.payload) as SlackEventPayload
      // Defensive: only enqueueSlackChannelEvent produces non-comment slack_app rows today, but
      // guard against a future comment-shaped payload mis-routing here (no `event` → skip).
      if (typeof e.event !== "string") return { ok: true, status: "skipped: not an event payload" }
      const bot = await resolveBotToken(meta, e.orgId, encryptionKey)
      if (!bot) return { ok: true, status: "skipped: slack not connected" }
      return postWithRecovery(
        meta,
        e.orgId,
        bot.token,
        {
          channel: e.channel,
          // The fallback text is parsed as mrkdwn too (notifications, blocks-failed render), so
          // untrusted author/title must be escaped here as well — else a name like `<!channel>`
          // could ping the channel via the fallback even though the blocks escape it.
          // Every interpolated field is escaped, `event` included — eventBlocks already escapes
          // it, and a uniform rule is what keeps this correct if the event vocabulary widens.
          text: `${mrkdwnLabel(e.author)}: ${escapeMrkdwn(e.event)} · ${mrkdwnLabel(e.title)}`,
          blocks: eventBlocks(e),
        },
        { autoJoin: true, textFallback: true },
      )
    }
    const p = JSON.parse(d.payload) as SlackCommentPayload
    const bot = await resolveBotToken(meta, p.orgId, encryptionKey)
    if (!bot) return { ok: true, status: "skipped: slack not connected" }
    // The row names its channel; the link tells us whether this thread already has a message
    // THERE to thread under. A thread mirrored into three channels has three of each.
    const channel = p.channel
    const existing = await meta.getSlackThreadLink(p.threadId, channel)

    const res = await postWithRecovery(
      meta,
      p.orgId,
      bot.token,
      {
        channel,
        text: `${mrkdwnLabel(p.author)} commented on ${mrkdwnLabel(p.title)}`,
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
 *  and writes the comment via ingestSlackReply, which dedupes a redelivery on the Slack
 *  message ts (a scan, not a DB uniqueness constraint — safe because the outbox drains one
 *  delivery at a time per deployment). Publishes comment.created on the bus when given one, so a live
 *  viewer sees it (Node runs the worker in-process; the edge has no cross-isolate bus here).
 *  No-ops (delivered) when the thread link/install is gone or the channel mirror is off, so
 *  a stale event never dead-letters. */
export const makeSlackIngestSender =
  (meta: MetaStore, encryptionKey: string | undefined, bus?: Pick<EventBus, "publish">) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as SlackIngestPayload
    const link = await meta.getSlackThreadLinkByTs(p.channel, p.threadTs)
    if (!link) return { ok: true, status: "skipped: no thread link" }
    // A thread link outlives an unsubscribe (nothing deletes them), so the subscription is what
    // says whether this channel is still connected — in BOTH directions.
    if (!(await channelIsSubscribed(meta, link.org_id, p.channel)))
      return { ok: true, status: "skipped: channel not subscribed" }
    const bot = await resolveBotToken(meta, link.org_id, encryptionKey)
    if (!bot) return { ok: true, status: "skipped: slack not connected" }
    const name = await slackUserName(bot.token, p.userId)
    // If the Slack author has linked their account, attribute the comment to their real Derive
    // user (and name) instead of an opaque slack:<id>; otherwise fall back to the Slack name.
    const userLink = await meta.getSlackUserLinkBySlackId(bot.install.team_id, p.userId)
    const deriveUser = userLink ? (await meta.getUsers([userLink.user_id]))[0] : undefined
    const created = await ingestSlackReply(meta, link, {
      ts: p.ts,
      userId: p.userId,
      userName: deriveUser?.name ?? name,
      text: p.text,
      botUserId: bot.install.bot_user_id,
      deriveUserId: userLink?.user_id ?? null,
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
  args: {
    ts: string
    userId: string
    userName: string
    text: string
    botUserId: string | null
    /** The linked Derive user id, when the Slack author has linked their account — the comment
     *  is then owned by that account; otherwise it's tagged with the opaque `slack:<id>`. */
    deriveUserId?: string | null
  },
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
    author_id: args.deriveUserId ?? `slack:${args.userId}`,
    meta: JSON.stringify({ slack: { ts: args.ts, channel: link.channel } }),
  })
}
