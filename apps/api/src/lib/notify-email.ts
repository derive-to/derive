// Resolve who should be emailed about a comment and enqueue pre-rendered email
// deliveries onto the outbox (kind="email"). Kept out of the route handler so the
// recipient policy lives in one place.
//
// Recipient policy: email is reserved for what's worth interrupting for, and for a
// comment that means being @MENTIONED — someone deliberately pulled you in. Thread
// replies reach participants as bell notifications (the route writes those); an
// earlier policy also emailed every workspace owner on every comment, which turned
// admins' inboxes into a firehose the moment agents multiplied comment volume.
// The comment's author is never emailed about their own comment.

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

  const recipientIds = new Set<string>(opts.mentionIds)
  recipientIds.delete("") // guard
  if (opts.actorId) recipientIds.delete(opts.actorId)
  if (recipientIds.size === 0) return

  const users = await meta.getUsers([...recipientIds])
  const quote = quoteOf(comment.anchor)
  await Promise.all(
    users
      .filter((u) => u.email)
      .map((u) => {
        const content = buildCommentEmail(baseUrl, artifact, {
          author: comment.author,
          body: comment.body_md,
          quote,
          threadId: comment.thread_id,
          mention: true,
        })
        return enqueueChannelDelivery(meta, "email", "comment.mention", {
          to: u.email,
          toName: u.name ?? undefined,
          ...content,
        })
      }),
  )
}
