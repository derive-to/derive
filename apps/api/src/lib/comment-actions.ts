// The side-effect chain that follows a NEW comment, extracted so every path that creates one
// runs the EXACT same fan-out: the HTTP route (routes/comments.ts) and the MCP `comment` tool
// (mcp-tools/comment.ts). Callers own authorization and the comment write; this just executes
// the consequences. Mirrors lib/thread-actions.ts.
//
// Before this existed the fan-out was inlined in the HTTP route, and the MCP tool grew its own
// partial copy: it belled people and published on the bus, but reached no webhook, no Slack
// channel, no email and no GitHub PR. That was drift, not policy — `isCollaboratorAuthor`
// deliberately returns true for a registered agent, so the trust gate was written to let an
// agent's comment through to exactly these channels.

import type { ArtifactRecord, BlobStore, CommentRecord, MetaStore } from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { log } from "../log"
import {
  DERIVE_AUTHOR_ID,
  isCollaboratorAuthor,
  type Mention,
  mentionsDerive,
  parseMeta,
  quoteOf,
} from "./comments"
import { enqueueGithubPrComment } from "./github-comments"
import { notifyMentions, notifyThreadReplyAgents } from "./mentions"
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
  /**
   * Answer an @derive mention in this thread, when the deploy has chat.
   *
   * Injected rather than imported so this module keeps its shape — a fan-out over channels —
   * and so the turn (which needs a model, the gate and the whole publish path) does not become
   * a dependency of every caller that merely posts a comment. Absent ⇒ a mention of Derive
   * simply reaches no one, which is what a deploy with no model configured should do.
   */
  answerDeriveMention?: (
    artifact: ArtifactRecord,
    comment: CommentRecord,
    asker: { id: string; name: string } | null,
  ) => Promise<void>
}

/**
 * Fan one new comment out to every channel it belongs on: webhooks (comment.created, plus
 * comment.mention when anyone was reached), mention DMs, notification bells, email, the GitHub
 * PR mirror and the Slack channel mirror.
 *
 * Best-effort by contract. Each delivery branch is isolated: a failed webhook, notification
 * write, or connected-channel enqueue is logged, but can neither undo the durable comment nor
 * prevent a later branch (especially a waiting @derive continuation) from running.
 *
 * The per-workspace Settings toggles gate the noisy channels, and the GitHub + Slack mirrors
 * additionally require a *collaborator* author. Note what that gate does and does NOT do:
 * anonymous callers cannot comment at all — the global anon-write lockdown (app.ts) 403s them,
 * and effectiveRole clamps an anonymous link holder to viewer — so the principal this actually
 * excludes is a SIGNED-IN user holding only a commenter/editor link, with no share and no seat.
 * An invited outsider's comment stays in Derive instead of being relayed into a connected repo
 * or channel.
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
     *  (the main way agents reach Derive) mirror nowhere.
     *
     *  CONTRACT: the caller must already have authorized the request AS this principal for THIS
     *  artifact. Nothing here re-checks that — it is an id, not a proof, and passing one the
     *  caller didn't authenticate would widen the mirror. The MCP tool satisfies it because
     *  `reach` resolves the artifact through the grant's own workspaces + membership before any
     *  write. Any new caller owes the same guarantee. */
    onBehalfOf?: string | null
  },
): Promise<void> => {
  const { meta, bus, blobs, baseUrl, notify } = deps
  const { mentions, actorId, onBehalfOf } = opts
  const mentionIds = new Set(mentions.map((m) => m.id))
  const fanOut = async <T>(surface: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (err) {
      log.warn("comment fan-out failed", {
        artifact: artifact.id,
        comment: comment.id,
        surface,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  await fanOut("webhook:comment.created", () =>
    notify(artifact, "comment.created", {
      author: comment.author,
      body: comment.body_md,
      quote: quoteOf(comment.anchor),
      thread_id: comment.thread_id,
    }),
  )
  const notified =
    (await fanOut("mentions", () =>
      notifyMentions({ meta, bus }, artifact, comment, mentions, actorId),
    )) ?? []
  if (notified.length) {
    await fanOut("webhook:comment.mention", () =>
      notify(artifact, "comment.mention", {
        author: comment.author,
        mentioned: notified,
        body: comment.body_md,
        quote: quoteOf(comment.anchor),
        thread_id: comment.thread_id,
      }),
    )
    // DM opted-in teammates who were mentioned (recipient resolved at delivery time).
    await fanOut("slack:mention-dm", () =>
      enqueueSlackMentionDms(
        { meta, baseUrl },
        artifact,
        comment,
        mentions.filter((m) => m.id !== actorId),
      ),
    )
  }
  await fanOut("agent:thread-reply", () =>
    notifyThreadReplyAgents({ meta, bus }, artifact, comment, actorId, mentionIds),
  )
  // Bell the comment's natural audience — thread participants + the artifact's owners.
  await fanOut("bells", () =>
    notifyCommentBells({ meta, bus }, artifact, comment, { mentionIds, actorId }),
  )
  // Channel fan-out is gated per workspace (Settings -> Integrations toggles).
  const settings = await fanOut("settings", () => meta.getOrgSettings(artifact.org_id))
  if (settings?.emailNotifications)
    await fanOut("email", () =>
      enqueueCommentEmails({ meta, baseUrl }, artifact, comment, { mentionIds, actorId }),
    )
  // The mirrors need a collaborator author — which excludes a signed-in holder of a
  // commenter/editor LINK (no share, no seat), not an anonymous visitor: those can't comment at
  // all. The author counts if it is itself a collaborator, or acting for one (see `onBehalfOf`).
  // onBehalfOf first when present: for an OAuth grant it is a plain membership hit, whereas
  // the synthetic author id misses three lookups (membership, artifact member, then a full
  // listAgents scan) before failing.
  const trustedAuthor =
    (await fanOut(
      "collaborator-check",
      async () =>
        (!!onBehalfOf && (await isCollaboratorAuthor(meta, artifact, onBehalfOf))) ||
        (await isCollaboratorAuthor(meta, artifact, actorId)),
    )) ?? false
  // A refusal here is a deliberate policy outcome, but an INVISIBLE one: the comment saves, the
  // response is 201, and the mirrors simply never fire. Nothing distinguishes "correctly
  // withheld" from "broken" without reading the source, which is a bad place to be at the point
  // someone is asking why their channel is quiet. Logged with both ids, because which of the two
  // was consulted is the whole diagnosis: a null onBehalfOf means the CALLER skipped the
  // contract, while a present one that still fails means the principal genuinely isn't a
  // collaborator here.
  if (!trustedAuthor)
    log.info("comment mirror withheld: author is not a collaborator", {
      artifact: artifact.id,
      comment: comment.id,
      actorId,
      onBehalfOf: onBehalfOf ?? null,
    })
  if (trustedAuthor && settings?.githubPostComments)
    await fanOut("github", () =>
      enqueueGithubPrComment({ meta, blobs, baseUrl }, artifact, comment),
    )
  // No global on/off any more: a channel subscription is the switch, and resolveChannels
  // applies its event + author filters.
  if (trustedAuthor)
    await fanOut("slack:channel-mirror", () =>
      enqueueSlackComment({ meta, baseUrl }, artifact, comment),
    )
  await fanOut("outbox-poke", () => Promise.resolve(deps.pokeWebhooks?.()))

  // @derive — LAST, and deliberately here rather than in each route.
  //
  // This is the one fan-out every comment path already runs (the HTTP route, the MCP tool, the
  // rework flow, and the Slack reply ingest), so a mention typed in Slack answers for exactly
  // the same reason one typed in the web app does: same code, one place. Anything earlier in
  // this function is a notification; this is work, so it goes after the notifications have
  // landed and never blocks them.
  //
  // The gates, the recursion guard and the model all live behind `answerDeriveMention`, because
  // whether a mention should be answered is a question about the workspace and the deploy, not
  // about this comment.
  let resumesDerive = false
  if (
    deps.answerDeriveMention &&
    actorId &&
    actorId !== DERIVE_AUTHOR_ID &&
    !mentionsDerive(comment, mentions)
  ) {
    const prior = (await meta.listComments(artifact.id, { threadId: comment.thread_id }))
      .filter((c) => c.id !== comment.id && c.author_id === DERIVE_AUTHOR_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    if (prior && parseMeta(prior.meta).awaiting_reply) {
      // Consume the explicit waiting marker before starting the next turn. A Slack delivery can
      // retry after a crash; clearing it makes the replay a harmless no-op instead of a second
      // model conversation. (The reply itself remains in the transcript.)
      const md = parseMeta(prior.meta)
      md.awaiting_reply = false
      await meta.updateComment(prior.id, { meta: JSON.stringify(md) })
      resumesDerive = true
    }
  }
  if (deps.answerDeriveMention && (mentionsDerive(comment, mentions) || resumesDerive))
    await deps
      .answerDeriveMention(
        artifact,
        comment,
        actorId ? { id: actorId, name: comment.author } : null,
      )
      .catch((e) =>
        // Best-effort like every other channel here: a failed turn must not fail the comment
        // that triggered it, which is already saved and already visible.
        log.warn("derive mention turn failed", {
          artifact: artifact.id,
          comment: comment.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
}
