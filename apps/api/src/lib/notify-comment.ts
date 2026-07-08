// Bell fan-out for a new comment. Kept out of the route handlers so the HTTP and
// MCP comment paths share one recipient policy (they drifted before: MCP comments
// reached no one without an open tab).
//
// A comment bells you when it lands on YOUR territory:
//   - you authored an earlier comment in the thread (you're in the conversation), or
//   - you hold an owner row on the artifact (it's your content — the owner row is
//     written at publish for the human behind it, agents' on-behalf work included).
// The comment's author never hears about themselves, and anyone already covered by
// a stronger mention row is skipped. Bell only — email is reserved for interrupts
// (mentions / review requests / shares; see notify-email.ts).

import type { ArtifactRecord, CommentRecord, MetaStore } from "@derive/core"
import { newId } from "@derive/core"
import type { Backplane } from "../bus"
import { previewOf } from "./comments"

export interface CommentBellDeps {
  meta: MetaStore
  bus: Backplane
}

/** Create + stream the bell rows for one comment. Best-effort: callers run it in
 *  background() so a lookup failure never reaches the request. */
export const notifyCommentBells = async (
  deps: CommentBellDeps,
  artifact: ArtifactRecord,
  comment: CommentRecord,
  opts: { mentionIds: Set<string>; actorId: string | null },
): Promise<void> => {
  const { meta, bus } = deps

  const participants = (await meta.listComments(artifact.id))
    .filter((c) => c.thread_id === comment.thread_id && c.author_id)
    .map((c) => c.author_id as string)
  const owners = (await meta.listArtifactMembers(artifact.id))
    .filter((m) => m.role === "owner")
    .map((m) => m.user_id)

  const recipients = new Set<string>([...participants, ...owners])
  recipients.delete("")
  if (opts.actorId) recipients.delete(opts.actorId)
  for (const id of opts.mentionIds) recipients.delete(id)

  const rows = [...recipients].map((uid) => ({
    id: newId("n"),
    user_id: uid,
    actor: comment.author,
    kind: "comment" as const,
    artifact_id: artifact.id,
    artifact_short_id: artifact.short_id,
    artifact_title: artifact.title,
    thread_id: comment.thread_id,
    comment_id: comment.id,
    preview: previewOf(comment.body_md),
  }))
  // One bulk insert for the whole fan-out; the realtime bell stays one event per user.
  await meta.createNotifications(rows)
  for (const row of rows)
    bus.publish(`u:${row.user_id}`, {
      type: "notification",
      notification: { ...row, read: 0, created_at: new Date().toISOString() },
    })
}
