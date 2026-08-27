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
import { parseMeta } from "./comments"
import { principalKind } from "./principal-kind"
import { enqueueSlackThreadState } from "./slack-comments"

/** Who is settling or reopening the thread — a person, an agent, or (a Slack click by
 *  someone Derive can't map to a user) a name alone. */
export interface ThreadActor {
  id: string | null
  name: string | null
}

/**
 * Write the resolution onto the thread's root comment (its id IS the thread id): who, when,
 * and — for a publish that named the thread in `resolves` — which version settled it.
 * Reopening clears it, so the record never claims a resolve the state contradicts. Runs
 * AFTER the state flip and never before: a failed flip must not leave a phantom record.
 */
export const recordThreadResolution = async (
  meta: MetaStore,
  artifactId: string,
  threadId: string,
  state: Extract<CommentState, "open" | "resolved">,
  actor: ThreadActor | null,
  version: number | null = null,
): Promise<void> => {
  const root = await meta.getComment(threadId)
  if (!root || root.artifact_id !== artifactId) return
  const md = parseMeta(root.meta)
  if (state === "resolved")
    md.resolved = {
      at: new Date().toISOString(),
      by: actor?.name ?? null,
      by_id: actor?.id ?? null,
      by_kind: principalKind(actor?.id),
      version,
    }
  else delete md.resolved
  await meta.updateComment(root.id, { meta: JSON.stringify(md) })
}

export interface ThreadActionDeps {
  meta: MetaStore
  bus: Backplane
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** For the deep link on the rebuilt Slack card. */
  baseUrl: string
}

/** Resolve (or reopen, with state "open") the thread; returns the number of comments changed.
 *  `actor` is recorded on the thread and shown in the Slack card's footer the way a click
 *  already shows who pressed the button. */
export const resolveThreadAction = async (
  deps: ThreadActionDeps,
  artifact: ArtifactRecord,
  threadId: string,
  state: Extract<CommentState, "open" | "resolved">,
  actor?: ThreadActor,
): Promise<number> => {
  const { meta, bus, notify, baseUrl } = deps
  const updated = await meta.setThreadState(artifact.id, threadId, state)
  await recordThreadResolution(meta, artifact.id, threadId, state, actor ?? null)
  bus.publish(artifact.id, { type: "comment.resolved", thread_id: threadId, state })
  await notify(artifact, "comment.resolved", { state, thread_id: threadId })
  // After the state is durable, never before: the card must not claim a resolve that failed.
  // Enqueue-only — the outbox owns the retries, so a Slack outage can't fail the resolve.
  await enqueueSlackThreadState(
    { meta, baseUrl },
    artifact,
    threadId,
    state,
    actor?.name ?? undefined,
  )
  return updated
}
