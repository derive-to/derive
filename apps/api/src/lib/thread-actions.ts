// The resolve / reopen side-effect chain for a comment thread, extracted so both the HTTP
// route (routes/comments.ts) and the Slack interactivity handler (routes/slack.ts) run the
// EXACT same pipeline — flip every comment in the thread, announce it on the realtime bus,
// fan the event out to webhooks, and bring every mirrored Slack card in line. Callers own
// authorization; this just executes the action.
//
// That last step lives HERE rather than at each call site on purpose: the state a Slack card
// shows has to follow the thread no matter what moved it, and three of the four ways to resolve
// one (the web app, the API, an agent over MCP) are nowhere near Slack.

import type { ArtifactRecord, CommentState, MetaStore } from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { enqueueSlackThreadState } from "./slack-comments"

export interface ThreadActionDeps {
  meta: MetaStore
  bus: Backplane
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** For the deep link on the rebuilt Slack card. */
  baseUrl: string
}

/** Resolve (or reopen, with state "open") the thread; returns the number of comments changed.
 *  `actor` is the acting person's display name, shown in the Slack card's footer the way a
 *  click already shows who pressed the button. */
export const resolveThreadAction = async (
  deps: ThreadActionDeps,
  artifact: ArtifactRecord,
  threadId: string,
  state: Extract<CommentState, "open" | "resolved">,
  actor?: string,
): Promise<number> => {
  const { meta, bus, notify, baseUrl } = deps
  const updated = await meta.setThreadState(artifact.id, threadId, state)
  bus.publish(artifact.id, { type: "comment.resolved", thread_id: threadId, state })
  await notify(artifact, "comment.resolved", { state, thread_id: threadId })
  // After the state is durable, never before: the card must not claim a resolve that failed.
  // Enqueue-only — the outbox owns the retries, so a Slack outage can't fail the resolve.
  await enqueueSlackThreadState({ meta, baseUrl }, artifact, threadId, state, actor)
  return updated
}
