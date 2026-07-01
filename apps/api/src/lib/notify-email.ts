// Resolve who should be emailed about a comment and enqueue pre-rendered email
// deliveries onto the outbox (kind="email"). Kept out of the route handler so the
// recipient policy lives in one place.
//
// Recipient policy (intentionally NOT "every workspace member on every comment", which
// would be spam): a person is emailed when they are
//   - @mentioned in the comment (a "mention" email), or
//   - already a participant in the thread (authored an earlier comment in it), or
//   - a workspace owner/admin (so the people who run the space hear about activity).
// The comment's author is never emailed about their own comment. Per-user opt-out is
// applied by the caller's preference gate (added with the Settings UI).

import type { ArtifactRecord, CommentRecord, MetaStore } from "@derive/core"
import { enqueueChannelDelivery } from "../webhooks"
import { quoteOf } from "./comments"
import { buildCommentEmail } from "./email"

export interface EmailFanoutDeps {
  meta: MetaStore
  baseUrl: string
}

/** Enqueue comment-notification emails for the eligible recipients. Best-effort: any
 *  lookup failure throws to the caller's background() guard, never to the request. */
export const enqueueCommentEmails = async (
  deps: EmailFanoutDeps,
  artifact: ArtifactRecord,
  comment: CommentRecord,
  opts: { mentionIds: Set<string>; actorId: string | null },
): Promise<void> => {
  const { meta, baseUrl } = deps

  // Thread participants: distinct authors of earlier comments in the same thread.
  const threadAuthors = new Set(
    (await meta.listComments(artifact.id))
      .filter((c) => c.thread_id === comment.thread_id && c.author_id)
      .map((c) => c.author_id as string),
  )
  // Workspace owners.
  const owners = new Set(
    (await meta.listMemberships(artifact.org_id))
      .filter((m) => m.role === "owner")
      .map((m) => m.user_id),
  )

  const recipientIds = new Set<string>([...opts.mentionIds, ...threadAuthors, ...owners])
  recipientIds.delete("") // guard
  if (opts.actorId) recipientIds.delete(opts.actorId)
  if (recipientIds.size === 0) return

  const users = await meta.getUsers([...recipientIds])
  const quote = quoteOf(comment.anchor)
  await Promise.all(
    users
      .filter((u) => u.email)
      .map((u) => {
        const mention = opts.mentionIds.has(u.id)
        const content = buildCommentEmail(baseUrl, artifact, {
          author: comment.author,
          body: comment.body_md,
          quote,
          threadId: comment.thread_id,
          mention,
        })
        return enqueueChannelDelivery(
          meta,
          "email",
          mention ? "comment.mention" : "comment.created",
          { to: u.email, toName: u.name ?? undefined, ...content },
        )
      }),
  )
}
