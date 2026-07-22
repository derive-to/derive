import {
  type AutonomyFlags,
  type AutonomyLevel,
  classifyChange,
  decideWrite,
  type GateDecision,
} from "@derive/core"
import type { HostedAgentClient, RevisionInput } from "./client"

// The terminal action of a hosted-agent run: submit a revised artifact. This is
// the ONE write chokepoint the plan names — the autonomy gate is consumed here
// and nowhere else. The flow, safety-first:
//   1. read the current source
//   2. classify the change (freshness vs structural) — deterministic, no model
//   3. decideWrite(...) → live publish w/ review, proposal, or shadow
//   4. act, once (the run latch no-ops a second submit in the same run)
// Every input the gate needs is loaded by the CALLER (workspace flags, autonomy
// level) and passed in; this function does the classify + route, so it stays a
// small, exhaustively-testable seam over a mock client.

/** Per-run guard so a model that calls submit twice can't double-write. One
 *  instance per hosted-agent invocation; `settled` flips on the first success. */
export class RunLatch {
  settled = false
}

export interface SubmitContext {
  client: HostedAgentClient
  latch: RunLatch
  autonomy: AutonomyLevel
  flags: AutonomyFlags
  confidenceFloor?: number
}

export interface SubmitInput {
  shortId: string
  /** The full proposed new source. */
  content: string
  filename: string
  /** The agent's stated confidence in [0,1]; null when unstated (never auto-publishes). */
  confidence: number | null
  message?: string
  addresses?: string[]
}

export interface SubmitResult {
  decision: GateDecision
  changeKind: "freshness" | "structural"
  /** Present when a version or proposal was created; absent for shadow. */
  shortId?: string
  version?: number
  /** True when the run latch short-circuited a duplicate submit. */
  duplicate?: boolean
}

export async function submitRevision(
  ctx: SubmitContext,
  input: SubmitInput,
): Promise<SubmitResult> {
  // Idempotency: a clean prior submit settles the run. A second call is a no-op,
  // not a second write — the model occasionally re-emits its terminal tool call.
  if (ctx.latch.settled) return { decision: "shadow", changeKind: "freshness", duplicate: true }

  const before = await ctx.client.read(input.shortId)
  const changeKind = classifyChange(before, input.content)
  const decision = decideWrite({
    autonomy: ctx.autonomy,
    changeKind,
    confidence: input.confidence,
    flags: ctx.flags,
    confidenceFloor: ctx.confidenceFloor,
  })

  const rev: RevisionInput = {
    content: input.content,
    filename: input.filename,
    message: input.message,
    addresses: input.addresses,
  }

  // Shadow: the run happened and is recorded by the caller's ledger, but nothing
  // is filed. The rollout tier — a human can score what it WOULD have written.
  if (decision === "shadow") {
    ctx.latch.settled = true
    return { decision, changeKind }
  }

  const result =
    decision === "live_publish_with_review"
      ? await ctx.client.publishLive(input.shortId, rev, { requestReview: true })
      : await ctx.client.proposeRevision(input.shortId, rev)

  // Latch only AFTER a clean write: a thrown publish leaves the run un-settled so
  // the agent can legitimately retry within the same run (matching the runner).
  ctx.latch.settled = true
  return { decision, changeKind, shortId: result.short_id, version: result.version }
}
