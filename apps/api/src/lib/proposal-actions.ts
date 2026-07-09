// The approve / request-changes side-effect chains for a proposal, extracted so both the
// HTTP route (routes/proposals.ts) and the Slack interactivity handler run the EXACT same
// pipeline — publish the new version (approve), re-anchor threads, release the threads the
// proposal addressed, fan out the event. Callers own authorization + the open-state check;
// these just execute the decided action.

import {
  type ArtifactRecord,
  approveProposal,
  type BlobStore,
  type MetaStore,
  type ProposalRecord,
  type VersionRecord,
} from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { releaseAddressed } from "./addressed"
import { publishSweepEvents } from "./anchor-sweep"

export interface ProposalActionDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** Enqueue a screenshot render for the newly-published version. Fire-and-forget; optional
   *  so a caller without render access (e.g. a test) can omit it. */
  notifyRender?: (a: ArtifactRecord, n: number) => void
}

/** Approve: the proposed content becomes the new live version. Mirrors the approve route. */
export const approveProposalAction = async (
  deps: ProposalActionDeps,
  artifact: ArtifactRecord,
  proposal: ProposalRecord,
  approver: string | null,
  note: string | null,
): Promise<VersionRecord> => {
  const { meta, blobs, bus, notify, notifyRender } = deps
  const version = await approveProposal(meta, blobs, proposal, approver, note)
  bus.publish(artifact.id, { type: "proposal.approved", proposal_id: proposal.id, n: version.n })
  bus.publish(artifact.id, { type: "version.published", n: version.n, message: version.message })
  // The approved candidate is now live content — re-anchor existing threads so feedback on
  // changed text flips to `outdated`.
  await publishSweepEvents(meta, blobs, bus, artifact.id, version)
  // Threads this proposal addressed are now settled.
  for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "resolved"))
    bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "resolved" })
  await notify(artifact, "proposal.approved", {
    proposal_id: proposal.id,
    version: version.n,
    approver,
  })
  notifyRender?.(artifact, version.n)
  return version
}

/** Request changes: the candidate stays a proposal; the proposer can revise. */
export const requestChangesAction = async (
  deps: ProposalActionDeps,
  artifact: ArtifactRecord,
  proposal: ProposalRecord,
  reviewer: string | null,
  note: string | null,
): Promise<void> => {
  const { meta, bus, notify } = deps
  await meta.decideProposal(proposal.id, {
    state: "changes_requested",
    decided_by: reviewer,
    decided_version: null,
    decision_note: note,
  })
  bus.publish(artifact.id, { type: "proposal.changes_requested", proposal_id: proposal.id })
  // The fix didn't land — reopen the threads it had staged as addressed.
  for (const threadId of await releaseAddressed(meta, artifact.id, proposal.id, "open"))
    bus.publish(artifact.id, { type: "comment.addressed", thread_id: threadId, state: "open" })
  await notify(artifact, "proposal.changes_requested", { proposal_id: proposal.id, reviewer })
}
