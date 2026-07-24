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

/** The collaborator set for an artifact: workspace members ∪ explicit artifact-share
 *  recipients. This is the gate for who a comment may notify — a mention (bell OR email)
 *  only reaches someone who can actually SEE the artifact, never an arbitrary registered
 *  user id a caller supplied. Shared by the mention fan-out here and the email fan-out
 *  (lib/notify-email) so both apply the identical rule; "could view a public artifact" is
 *  intentionally NOT enough. */
export const collaboratorIds = async (meta: MetaStore, a: ArtifactRecord): Promise<Set<string>> =>
  new Set<string>([
    ...(await meta.listMemberships(a.org_id)).map((m) => m.user_id),
    ...(await meta.listArtifactMembers(a.id)).map((r) => r.user_id),
  ])

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
  // A mention only notifies someone who can actually SEE the artifact: a member of its
  // workspace or an explicit share recipient. The `mentions[]` array is caller-supplied,
  // so without this gate any caller could push a notification carrying attacker-controlled
  // title/preview to ANY other user — cross-workspace spam/phishing into the bell + SSE.
  // Same collaborator set the email fan-out gates on (see lib/notify-email).
  const collaborators = await collaboratorIds(meta, a)
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
