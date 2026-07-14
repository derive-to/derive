// The resolve / reopen side-effect chain for a comment thread, extracted so both the HTTP
// route (routes/comments.ts) and the Slack interactivity handler (routes/slack.ts) run the
// EXACT same pipeline — flip every comment in the thread, announce it on the realtime bus,
// fan the event out to webhooks. Callers own authorization; this just executes the action.
// Mirrors lib/proposal-actions.ts.

import type { ArtifactRecord, CommentState, MetaStore } from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"

export interface ThreadActionDeps {
  meta: MetaStore
  bus: Backplane
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
}

/** Resolve (or reopen, with state "open") the thread; returns the number of comments changed. */
export const resolveThreadAction = async (
  deps: ThreadActionDeps,
  artifact: ArtifactRecord,
  threadId: string,
  state: Extract<CommentState, "open" | "resolved">,
): Promise<number> => {
  const { meta, bus, notify } = deps
  const updated = await meta.setThreadState(artifact.id, threadId, state)
  bus.publish(artifact.id, { type: "comment.resolved", thread_id: threadId, state })
  await notify(artifact, "comment.resolved", { state, thread_id: threadId })
  return updated
}
