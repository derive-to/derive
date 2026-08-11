// Fan a comment's @mentions out to notifications: a bell + realtime signal for each
// mentioned human who can actually see the artifact, and a pull-inbox row for each
// mentioned agent. Extracted from the comment route so the Slack reply path (a Slack
// thread reply that @mentions linked teammates) runs the exact same collaborator-gated
// logic. Returns the display names actually notified.

import {
  type ArtifactRecord,
  type CommentRecord,
  type MetaStore,
  type NewNotification,
  newId,
} from "@derive/core"
import type { Backplane } from "../bus"
import { type Mention, previewOf } from "./comments"
import { eligibleMentionRecipientIds } from "./mention-access"

export const notifyMentions = async (
  deps: { meta: MetaStore; bus: Backplane },
  a: ArtifactRecord,
  cm: CommentRecord,
  mentions: Mention[],
  actorId: string | null,
): Promise<string[]> => {
  const { meta, bus } = deps
  const targetIds = mentions.map((m) => m.id).filter((mid) => mid !== actorId)
  if (targetIds.length === 0) return []
  const real = new Set((await meta.getUsers(targetIds)).map((u) => u.id))
  // Registered agents are mentionable too; a mention of an agent lands in its
  // pull inbox instead of a notification bell.
  const agentIds = new Set((await meta.listAgents(a.org_id)).map((ag) => ag.id))
  // A public link is never enough to page somebody: recipient eligibility is shared
  // with live-source mentions and includes only workspace/direct/collection standing.
  const collaborators = await eligibleMentionRecipientIds(meta, a, real)
  const preview = previewOf(cm.body_md)
  // Collect the human-mention bell rows so the whole fan-out is ONE bulk insert; agent
  // mentions land in their own table (a pull inbox), still one row each.
  const notifRows: NewNotification[] = []
  const notified: string[] = []
  for (const m of mentions) {
    if (m.id === actorId) continue
    if (real.has(m.id) && collaborators.has(m.id)) {
      notifRows.push({
        id: newId("n"),
        user_id: m.id,
        actor: cm.author,
        kind: "mention",
        artifact_id: a.id,
        artifact_short_id: a.short_id,
        artifact_title: a.title,
        thread_id: cm.thread_id,
        comment_id: cm.id,
        preview,
      })
      notified.push(m.name)
    } else if (agentIds.has(m.id)) {
      await meta.createAgentMention({
        id: newId("amn"),
        agent_id: m.id,
        artifact_id: a.id,
        artifact_short_id: a.short_id,
        comment_id: cm.id,
        thread_id: cm.thread_id,
        body: cm.body_md,
        author: cm.author,
        kind: "mention",
      })
      // Wake a session that's long-polling this agent's inbox (check_requests's
      // `wait`). Signal-only, mirroring the human bell path above — no body on the
      // bus; the handler re-reads the inbox from the store. Fire-and-forget: an
      // offline agent simply picks the row up on its next connect.
      bus.publish(`u:${m.id}`, {
        type: "request.created",
        artifact: a.short_id,
        thread_id: cm.thread_id,
      })
      notified.push(m.name)
    }
  }
  if (notifRows.length) {
    await meta.createNotifications(notifRows)
    for (const row of notifRows)
      bus.publish(`u:${row.user_id}`, {
        type: "notification",
        notification: { ...row, read: 0, created_at: new Date().toISOString() },
      })
  }
  return notified
}

/** Wake registered agents that already participated in this thread when a real human replies.
 * This is deliberately separate from an @mention: it represents "the answer to work you left
 * here", so the agent's inbox can resume the right task without making a human repeat its name.
 * An explicit mention wins and is not duplicated as a thread-reply row. */
export const notifyThreadReplyAgents = async (
  deps: { meta: MetaStore; bus: Pick<Backplane, "publish"> },
  artifact: ArtifactRecord,
  comment: CommentRecord,
  actorId: string | null,
  mentionedIds: Set<string> = new Set(),
): Promise<void> => {
  if (!actorId) return
  // Never treat an opaque Slack identity, another agent, or a deleted account as a human answer.
  if (!(await deps.meta.getUsers([actorId]))[0]) return
  const agents = new Map((await deps.meta.listAgents(artifact.org_id)).map((a) => [a.id, a]))
  const participants = await deps.meta.listComments(artifact.id, { threadId: comment.thread_id })
  const recipients = new Set(
    participants
      .map((c) => c.author_id)
      .filter(
        (id): id is string => !!id && id !== actorId && agents.has(id) && !mentionedIds.has(id),
      ),
  )
  for (const id of recipients) {
    await deps.meta.createAgentMention({
      // This is a durable wake-up, reached through an at-least-once Slack outbox. A stable
      // primary key means a retry after the comment write repairs a missed wake-up without
      // giving the agent two copies of the same human answer.
      id: `amr_${comment.id}_${id}`,
      agent_id: id,
      artifact_id: artifact.id,
      artifact_short_id: artifact.short_id,
      comment_id: comment.id,
      thread_id: comment.thread_id,
      body: comment.body_md,
      author: comment.author,
      kind: "thread_reply",
    })
    deps.bus.publish(`u:${id}`, {
      type: "request.created",
      artifact: artifact.short_id,
      thread_id: comment.thread_id,
    })
  }
}
