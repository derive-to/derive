import type { MastraLanguageModel } from "@mastra/core/agent"
import { createHostedAgent } from "./agent"
import { type ClaimedRun, httpClient } from "./client"
import { outcomeOf, RunLatch } from "./submit"
import type { RunContext } from "./tools"

// The executor loop for the run queue — the pull half of the executor. It claims this
// agent's due queued runs and, for each, runs the harness with the automation's instruction:
// the submit_revision tool routes the write through the SAME autonomy gate as any agent, and
// the claimed run is finished with the outcome. Both lanes call this with the agent's bearer
// (the owner runner with the user's token, the shared host with a Derive-held one) — auth is
// clean because the executor only ever acts as the one agent it holds the token for.
//
// Best-effort per run: a run that throws is finished `failed` and the drain continues, so one
// bad automation can't stall the queue. The polling cadence (how often this is called) is the
// deployment concern; this function is one pass.

/** Resolve the model instance. Supplied by the caller so this package imports no provider
 *  SDK — provider neutrality lives in the host's config. */
export type DrainModelResolver = () => MastraLanguageModel

/** Execute one claimed run's task in its context: build the agent and generate. Injectable
 *  as a whole so the loop is testable without constructing a live model. The context's
 *  submit tool sets ctx.lastResult, which the loop maps to the finish outcome. */
export type RunOne = (ctx: RunContext, task: string) => Promise<void>

export interface DrainDeps {
  server: string
  /** The hosted agent's bearer — every claim and write runs as this principal. */
  agentToken: string
  /** The agent's system prompt (manifest + Brandprint), as the runner materializes it. */
  manifest: string
  conventions?: string
  resolveModel: DrainModelResolver
  /** Override the per-run executor (tests inject a fake); default builds + generates. */
  runOne?: RunOne
  limit?: number
}

export interface DrainResult {
  claimed: number
  finished: number
  failed: number
}

/** The task text for a claimed run: its instruction, plus any refs as trailing context. */
const taskFor = (r: ClaimedRun): string =>
  r.refs.length > 0
    ? `${r.instruction}\n\nTarget artifacts (short ids): ${r.refs.join(", ")}`
    : r.instruction

/** Run one claim → execute → finish pass for a hosted agent. */
export async function drainRuns(deps: DrainDeps): Promise<DrainResult> {
  const client = httpClient(deps.server, deps.agentToken)
  const runOne: RunOne =
    deps.runOne ??
    (async (ctx, task) => {
      const agent = createHostedAgent({
        manifest: deps.manifest,
        conventions: deps.conventions,
        model: deps.resolveModel(),
        run: ctx,
      })
      await agent.generate(task)
    })

  const claimed = await client.claimRuns(deps.limit ?? 10)
  let finished = 0
  let failed = 0
  for (const r of claimed) {
    // One fresh context per run: its own latch, and the gate inputs the server resolved and
    // handed back with the claim (autonomy from the automation's route, workspace flags fresh
    // at claim time). The submit tool consumes them — the executor never re-decides.
    const ctx: RunContext = {
      client,
      latch: new RunLatch(),
      autonomy: r.autonomy,
      flags: r.flags,
    }
    let ok = true
    try {
      await runOne(ctx, taskFor(r))
    } catch {
      ok = false
    }
    // Finish the CLAIMED run (not an ad-hoc record). Best-effort: the ledger never gates work.
    await client
      .finishRun(r.id, {
        status: ok ? "succeeded" : "failed",
        meta: {
          outcome: ok ? outcomeOf(ctx.lastResult) : "failed",
          artifact_short_id: ctx.lastResult?.shortId ?? null,
        },
      })
      .catch(() => {})
    if (ok) finished += 1
    else failed += 1
  }
  return { claimed: claimed.length, finished, failed }
}
