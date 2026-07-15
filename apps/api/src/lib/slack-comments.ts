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
import { slackUserName } from "./slack"
import { actionButton, actions, context, escapeMrkdwn, section } from "./slack-cards"
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

/** The self-contained payload for a channel EVENT card (publish / proposal lifecycle). Carried
 *  on a `slack_app` delivery whose `event_type` is the event — the sender routes on that, so
 *  event cards and the comment mirror share the kind without a payload discriminator. */
interface SlackEventPayload {
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

/** Artifact-lifecycle events that post a top-level card to the connected channel (comments
 *  mirror separately + threaded, so they're NOT here). Everything else `notify` fans out to
 *  webhooks only. */
const CHANNEL_EVENTS = new Set<WebhookEvent>([
  "version.published",
  "proposal.created",
  "proposal.approved",
  "proposal.changes_requested",
])

/** Enqueue a top-level channel card for an artifact-lifecycle event, when the org has a
 *  connected channel and the mirror (slackPost) is on. Returns whether it enqueued (so the
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
  // Only broadcast feed-visible artifacts. A private draft (listed "none") is visible to its
  // owner + explicit shares — its publish/proposal title must not leak to the org-wide channel.
  if (artifact.listed === "none") return false
  const install = await meta.getSlackInstall(artifact.org_id)
  if (!install?.default_channel) return false
  if (!(await meta.getOrgSettings(artifact.org_id)).slackPost) return false
  const actor = [data.author, data.approver, data.reviewer].find((v) => typeof v === "string")
  const payload: SlackEventPayload = {
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
  return true
}

/** Block Kit for a channel event card. Untrusted text (title, author, message) is escaped so
 *  it can't break out of a `<url|text>` link or inject markup. */
const eventBlocks = (p: SlackEventPayload): unknown[] => {
  const link = `<${p.link}|${escapeMrkdwn(p.title)}>`
  const who = escapeMrkdwn(p.author)
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
    default:
      head = `${link} — ${escapeMrkdwn(p.event)}`
  }
  const body = p.message ? `${head}\n> ${escapeMrkdwn(truncate(p.message, 280))}` : head
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

/** The action + context blocks under a comment card for a given thread state. Rebuilt by the
 *  interactivity handler after a resolve/reopen (with `who` = the Slack user who acted) and
 *  used for the first post (open, no `who`). `value` is the encoded thread target. */
export const threadStateBlocks = (
  state: "open" | "resolved",
  value: string,
  who?: string,
): unknown[] =>
  state === "resolved"
    ? [
        actions([actionButton(SLACK_THREAD_ACTION.reopen, "Reopen thread", value)]),
        context(`Derive · :white_check_mark: resolved${who ? ` by ${who}` : ""}`),
      ]
    : [
        actions([actionButton(SLACK_THREAD_ACTION.resolve, "Resolve thread", value, "primary")]),
        context(
          who
            ? `Derive · reopened by ${who} · reply in this thread to post back`
            : "Derive · reply in this thread to post back",
        ),
      ]

/** Slack Block Kit blocks for a comment post (open thread, with a Resolve button). */
const blocksFor = (p: SlackCommentPayload): unknown[] => [
  section(
    `:speech_balloon: *${p.author}* commented on <${p.link}|${p.title}>\n${truncate(p.text, 600)}`,
  ),
  ...threadStateBlocks("open", encodeThreadAction(p.artifactId, p.threadId)),
]

/** Build the slack_app delivery sender for a runtime. Resolves the channel + thread from
 *  the stored install + thread link, posts via chat.postMessage, and records the Slack
 *  message ts for a new thread so future replies thread under it. No-ops (delivered) when
 *  Slack isn't connected so a row never dead-letters on a tier without Slack. */
export const makeSlackSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    // Event cards (publish / proposal lifecycle) ride the same kind but a different event_type,
    // and post top-level (not threaded under an artifact's comment message).
    if (d.event_type !== "comment.created") {
      const e = JSON.parse(d.payload) as SlackEventPayload
      // Defensive: only enqueueSlackChannelEvent produces non-comment slack_app rows today, but
      // guard against a future comment-shaped payload mis-routing here (no `event` → skip).
      if (typeof e.event !== "string") return { ok: true, status: "skipped: not an event payload" }
      const bot = await resolveBotToken(meta, e.orgId, encryptionKey)
      if (!bot?.install.default_channel) return { ok: true, status: "skipped: slack not connected" }
      return postWithRecovery(
        meta,
        e.orgId,
        bot.token,
        {
          channel: bot.install.default_channel,
          text: `${e.author}: ${e.event} · ${e.title}`,
          blocks: eventBlocks(e),
        },
        { autoJoin: true, textFallback: true },
      )
    }
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
    if (!(await meta.getOrgSettings(link.org_id)).slackPost)
      return { ok: true, status: "skipped: channel mirror off" }
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
