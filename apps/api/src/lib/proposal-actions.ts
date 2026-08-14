// The approve / request-changes side-effect chains for a proposal, extracted so both the
// HTTP route (routes/proposals.ts) and the Slack interactivity handler run the EXACT same
// pipeline — publish the new version (approve), re-anchor threads, release the threads the
// proposal addressed, fan out the event. Callers own authorization; the store owns
// the single-winner open-state transition before these emit any side effects.

import {
  type ArtifactRecord,
  approveProposal,
  type BlobStore,
  type MetaStore,
  type ProposalRecord,
  type SearchIndex,
  type VersionRecord,
} from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { log } from "../log"
import type { Summarizer } from "../summarizer"
import { releaseAddressed } from "./addressed"
import { emitVersionBump } from "./after-publish"
import { fanOutNewContentMentions } from "./content-mentions"

export interface ProposalActionDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** Enqueue a screenshot render for the newly-published version. Fire-and-forget; optional
   *  so a caller without render access (e.g. a test) can omit it. */
  notifyRender?: (a: ArtifactRecord, n: number) => void
  /** The optional dense/semantic index — an approved proposal is a version bump, so it keeps
   *  the index current too (best-effort, via emitVersionBump). Absent on self-host. */
  search?: SearchIndex
  /** Likewise the summarizer: approving a proposal publishes new content, so its card should
   *  describe what the new version says rather than what the old one did. */
  summarize?: Summarizer
  /** Keep the body-mention side effect off an HTTP/Slack approval response. */
  background?: (work: Promise<unknown>) => Promise<void>
  /** The document origin for body-mention emails. */
  baseUrl?: string
}

/** Approve: the proposed content becomes the new live version. Mirrors the approve route. */
export const approveProposalAction = async (
  deps: ProposalActionDeps,
  artifact: ArtifactRecord,
  proposal: ProposalRecord,
  approver: string,
  note: string | null,
  /** The human decider's stable id. `approver` is only the audit-display snapshot; this id is
   *  persisted on the proposal and tells subscriptions who acted. */
  actorId: string,
): Promise<VersionRecord> => {
  const { meta, blobs, bus, notify, notifyRender, search } = deps
  const version = await approveProposal(meta, blobs, proposal, approver, actorId, note)
  bus.publish(artifact.id, { type: "proposal.approved", proposal_id: proposal.id, n: version.n })
  // The approved candidate is now live content: run the shared version-bump core (announce
  // the version so open tabs reload, enqueue the preview render, re-anchor existing threads).
  await emitVersionBump(
    { meta, blobs, bus, notifyRender, search, summarize: deps.summarize },
    artifact,
    version,
  )
  // A proposal approval is a live body edit too. Its author is the person who proposed the
  // bytes (not the reviewer clicking Approve), so compare against version attribution here.
  const mentionWork = fanOutNewContentMentions(
    { meta, blobs, bus, baseUrl: deps.baseUrl },
    artifact,
    version,
    version.author_id,
  ).catch((err) =>
    log.warn("content mention fan-out failed", {
      artifact: artifact.id,
      version: version.n,
      surface: "proposal-approve",
      error: err instanceof Error ? err.message : String(err),
    }),
  )
  await (deps.background ? deps.background(mentionWork) : mentionWork)
  // Threads this proposal addressed are now settled.
  for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "resolved"))
    bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "resolved" })
  await notify(artifact, "proposal.approved", {
    proposal_id: proposal.id,
    version: version.n,
    approver,
    actor_id: actorId,
  })
  return version
}

/** Request changes: the candidate stays a proposal; the proposer can revise. */
export const requestChangesAction = async (
  deps: ProposalActionDeps,
  artifact: ArtifactRecord,
  proposal: ProposalRecord,
  reviewer: string,
  note: string | null,
  /** As approveProposalAction — the human decider's stable id. */
  actorId: string,
): Promise<boolean> => {
  const { meta, bus, notify } = deps
  const decided = await meta.decideProposal(proposal.id, {
    state: "changes_requested",
    decided_by: reviewer,
    decided_by_id: actorId,
    decided_version: null,
    decision_note: note,
  })
  if (!decided) return false
  bus.publish(artifact.id, { type: "proposal.changes_requested", proposal_id: proposal.id })
  // The fix didn't land — reopen the threads it had staged as addressed.
  for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "open"))
    bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "open" })
  await notify(artifact, "proposal.changes_requested", {
    proposal_id: proposal.id,
    reviewer,
    actor_id: actorId,
  })
  return true
}
