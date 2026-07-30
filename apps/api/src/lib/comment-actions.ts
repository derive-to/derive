// The side-effect chain that follows a NEW comment, extracted so every path that creates one
// runs the EXACT same fan-out: the HTTP route (routes/comments.ts) and the MCP `comment` tool
// (mcp-tools/comment.ts). Callers own authorization and the comment write; this just executes
// the consequences. Mirrors lib/thread-actions.ts and lib/proposal-actions.ts.
//
// Before this existed the fan-out was inlined in the HTTP route, and the MCP tool grew its own
// partial copy: it belled people and published on the bus, but reached no webhook, no Slack
// channel, no email and no GitHub PR. That was drift, not policy — `isCollaboratorAuthor`
// deliberately returns true for a registered agent, so the trust gate was written to let an
// agent's comment through to exactly these channels.

import type { ArtifactRecord, BlobStore, CommentRecord, MetaStore } from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { isCollaboratorAuthor, type Mention, quoteOf } from "./comments"
import { enqueueGithubPrComment } from "./github-comments"
import { notifyMentions } from "./mentions"
import { notifyCommentBells } from "./notify-comment"
import { enqueueCommentEmails } from "./notify-email"
import { enqueueSlackComment } from "./slack-comments"
import { enqueueSlackMentionDms } from "./slack-dm"

export interface CommentActionDeps {
  meta: MetaStore
  bus: Backplane
  blobs: BlobStore
  baseUrl: string
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** Drain the outbox now rather than on the next tick. Absent on runtimes without a drainer. */
  pokeWebhooks?: () => void
}

/**
 * Fan one new comment out to every channel it belongs on: webhooks (comment.created, plus
 * comment.mention when anyone was reached), mention DMs, notification bells, email, the GitHub
 * PR mirror and the Slack channel mirror.
 *
 * Best-effort by contract — callers run it off the response path (the HTTP route's
 * `background()`), so a lookup failure here must never reach the request.
 *
 * The per-workspace Settings toggles gate the noisy channels, and the GitHub + Slack mirrors
 * additionally require a *collaborator* author, so an anonymous commenter on a public artifact
 * can't push text into a connected repo or channel.
 */
export const commentCreatedAction = async (
  deps: CommentActionDeps,
  artifact: ArtifactRecord,
  comment: CommentRecord,
  opts: {
    mentions: Mention[]
    actorId: string | null
    /** The human principal an agent is acting for, when the author isn't a principal in its
     *  own right. An OAuth grant authors as `oauth:<client>` — a synthetic id that is never a
     *  row in the agents table — so the collaborator check can't see it, even though the grant
     *  runs under a member's authority and is role-capped by that member's seat
     *  (lib/oauth-agent.ts). Without this, comments from the standard remote-MCP connector
     *  (the main way agents reach Derive) mirror nowhere. */
    onBehalfOf?: string | null
  },
): Promise<void> => {
  const { meta, bus, blobs, baseUrl, notify } = deps
  const { mentions, actorId, onBehalfOf } = opts
  const mentionIds = new Set(mentions.map((m) => m.id))

  await notify(artifact, "comment.created", {
    author: comment.author,
    body: comment.body_md,
    quote: quoteOf(comment.anchor),
    thread_id: comment.thread_id,
  })
  const notified = await notifyMentions({ meta, bus }, artifact, comment, mentions, actorId)
  if (notified.length) {
    await notify(artifact, "comment.mention", {
      author: comment.author,
      mentioned: notified,
      body: comment.body_md,
      quote: quoteOf(comment.anchor),
      thread_id: comment.thread_id,
    })
    // DM opted-in teammates who were mentioned (recipient resolved at delivery time).
    await enqueueSlackMentionDms(
      { meta, baseUrl },
      artifact,
      comment,
      mentions.filter((m) => m.id !== actorId),
    )
  }
  // Bell the comment's natural audience — thread participants + the artifact's owners.
  await notifyCommentBells({ meta, bus }, artifact, comment, { mentionIds, actorId })
  // Channel fan-out is gated per workspace (Settings -> Integrations toggles).
  const settings = await meta.getOrgSettings(artifact.org_id)
  if (settings.emailNotifications)
    await enqueueCommentEmails({ meta, baseUrl }, artifact, comment, { mentionIds, actorId })
  // The mirrors need a collaborator author, so an anonymous commenter on a public artifact
  // can't push text into a connected repo or channel. The author counts if it is itself a
  // collaborator, or if it is acting for one (see `onBehalfOf`).
  const trustedAuthor =
    (await isCollaboratorAuthor(meta, artifact, actorId)) ||
    (!!onBehalfOf && (await isCollaboratorAuthor(meta, artifact, onBehalfOf)))
  if (trustedAuthor && settings.githubPostComments)
    await enqueueGithubPrComment({ meta, blobs, baseUrl }, artifact, comment)
  if (trustedAuthor && settings.slackPost)
    await enqueueSlackComment({ meta, baseUrl }, artifact, comment)
  deps.pokeWebhooks?.()
}
