import type { CommentState, MetaStore } from "@dock/core"
import { type CommentMeta, parseMeta } from "./comments"

// Linking a proposal to the comment threads it claims to fix, without a schema
// change: the link lives in each root comment's existing `meta` JSON
// (`addressed_by` = the proposal id) alongside the `addressed` thread state.
// propose marks; approve/withdraw/changes release.

/**
 * Flip the cited threads to `addressed`, tagging each root comment's meta with
 * the proposal id so a later approve/withdraw can release exactly these.
 * A thread is addressable only if its root exists on this artifact and isn't
 * already resolved (don't pull settled feedback back into a pending state).
 * Returns the thread ids actually marked.
 */
export async function markAddressed(
  meta: Pick<MetaStore, "getComment" | "setThreadState" | "updateComment">,
  artifactId: string,
  proposalId: string,
  threadIds: string[],
): Promise<string[]> {
  const marked: string[] = []
  for (const threadId of threadIds) {
    const root = await meta.getComment(threadId)
    if (!root || root.artifact_id !== artifactId || root.id !== threadId) continue
    if (root.state === "resolved") continue
    const md: CommentMeta = { ...parseMeta(root.meta), addressed_by: proposalId }
    await meta.updateComment(root.id, { meta: JSON.stringify(md) })
    await meta.setThreadState(artifactId, threadId, "addressed")
    marked.push(threadId)
  }
  return marked
}

/**
 * Release every thread addressed by `proposalId` to `toState` — `resolved` when
 * the proposal is approved (the fix landed), `open` when it's withdrawn or sent
 * back for changes — clearing the meta tag. Returns the thread ids released.
 */
export async function releaseAddressed(
  meta: Pick<MetaStore, "listComments" | "setThreadState" | "updateComment">,
  artifactId: string,
  proposalId: string,
  toState: Extract<CommentState, "open" | "resolved">,
): Promise<string[]> {
  const comments = await meta.listComments(artifactId)
  const released: string[] = []
  for (const cm of comments) {
    if (cm.id !== cm.thread_id) continue // the root carries the tag + the state
    const md = parseMeta(cm.meta)
    if (md.addressed_by !== proposalId) continue
    delete md.addressed_by
    await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
    await meta.setThreadState(artifactId, cm.thread_id, toState)
    released.push(cm.thread_id)
  }
  return released
}
