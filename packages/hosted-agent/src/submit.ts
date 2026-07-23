import {
  type AutonomyFlags,
  type AutonomyLevel,
  type ChangeKind,
  classifyChange,
  decideWrite,
  type GateDecision,
  type RunOutcome,
} from "@derive/core"
import type { HostedAgentClient, RevisionInput } from "./client"

// The terminal action of a hosted-agent run: submit a write. This is the ONE
// write chokepoint the plan names — the autonomy gate is consumed here and
// nowhere else. Two shapes, one door:
//   revision (shortId given): read current → classify (freshness/structural) → gate
//   creation (shortId omitted): changeKind = "creation" (additive; no before-text) → gate
// The gate maps creation-proposals to a PRIVATE create (workspace_access none +
// review round): the artifact exists but only the agent's registrant sees it —
// a proposal in property-space, since the proposals table is revision-only.
// Every write is stamped with the run's tag-targets via add_tags — platform-
// deterministic, the model never has to remember.

/** Per-run write budget: a model may write at most `limit` times in one run
 *  (default 3 — the destination plus a couple of auxiliary creations). Taken
 *  synchronously before any await so parallel tool calls can't double-spend;
 *  released on a thrown write so a legitimate retry can still proceed. */
export class RunBudget {
  used = 0
  constructor(readonly limit: number = 3) {}
  get exhausted(): boolean {
    return this.used >= this.limit
  }
}

export interface SubmitContext {
  client: HostedAgentClient
  budget: RunBudget
  autonomy: AutonomyLevel
  flags: AutonomyFlags
  confidenceFloor?: number
  /** Tag labels from the run's targets — stamped on every write (add_tags). */
  stampTags?: string[]
  /** Every write this run performed, in order — the ledger's writes[] source. */
  results: SubmitResult[]
}

export interface SubmitInput {
  /** Omit to CREATE a new artifact (the task must ask for one); pass to revise. */
  shortId?: string
  /** Title for a creation; ignored on revision. */
  title?: string
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
  changeKind: ChangeKind
  /** Present when a version or proposal was created; absent for shadow. */
  shortId?: string
  version?: number
  /** True when this write CREATED a new artifact. */
  created?: boolean
  /** True when the write budget refused this submit (nothing was written). */
  overBudget?: boolean
}

export async function submitRevision(
  ctx: SubmitContext,
  input: SubmitInput,
): Promise<SubmitResult> {
  // Spend the budget SYNCHRONOUSLY (check-then-increment with no await between) so
  // parallel tool calls can't double-spend. A thrown write refunds it (in the catch)
  // so a legitimate retry within the same run can still proceed.
  if (ctx.budget.exhausted) return { decision: "shadow", changeKind: "freshness", overBudget: true }
  ctx.budget.used += 1
  try {
    const creating = !input.shortId
    const before = creating ? "" : await ctx.client.read(input.shortId as string)
    const changeKind: ChangeKind = creating ? "creation" : classifyChange(before, input.content)
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
      addTags: ctx.stampTags,
    }

    // Shadow: the run happened and is recorded by the caller's ledger, but nothing is filed.
    // A shadow write refunds the budget — nothing was spent on the workspace.
    if (decision === "shadow") {
      ctx.budget.used -= 1
      const out: SubmitResult = { decision, changeKind }
      ctx.results.push(out)
      return out
    }

    let result: { short_id: string; version: number }
    if (creating) {
      // Creation: live → normal create + review round; proposal → PRIVATE create
      // (workspace_access none) + review round, so a human promotes it to make it real.
      result = await ctx.client.createArtifact(rev, {
        title: input.title || "Untitled",
        requestReview: true,
        privateDraft: decision === "proposal",
      })
    } else {
      result =
        decision === "live_publish_with_review"
          ? await ctx.client.publishLive(input.shortId as string, rev, { requestReview: true })
          : await ctx.client.proposeRevision(input.shortId as string, rev)
    }

    const out: SubmitResult = {
      decision,
      changeKind,
      shortId: result.short_id,
      version: result.version,
      created: creating || undefined,
    }
    ctx.results.push(out)
    return out
  } catch (e) {
    ctx.budget.used -= 1
    throw e
  }
}

/** Map a run's writes to its ledger outcome: the most consequential write wins
 *  (published > proposed > shadow); no writes at all is an answer. */
export function outcomeOf(results: SubmitResult[] | undefined): RunOutcome {
  const rs = results ?? []
  if (rs.some((r) => r.decision === "live_publish_with_review")) return "published"
  if (rs.some((r) => r.decision === "proposal")) return "proposed"
  if (rs.length > 0) return "shadow"
  return "answered"
}
