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
  /** Hard ceiling per run; a model call that hangs past it finishes `failed` and the
   *  drain moves on (default 5 minutes). */
  runTimeoutMs?: number
}

export interface DrainResult {
  claimed: number
  finished: number
  failed: number
  /** Runs whose work completed but whose finish POST failed even after a retry — they
   *  are stuck `running` server-side until the reclaim sweep. Never silently folded
   *  into `finished`: an executor that can't report is a fact worth surfacing. */
  finishFailures: number
}

/** The task text for a claimed run: its instruction, plus any refs as trailing context. */
const taskFor = (r: ClaimedRun): string =>
  r.refs.length > 0
    ? `${r.instruction}\n\nTarget artifacts (short ids): ${r.refs.join(", ")}`
    : r.instruction

/** `runOne` raced against the per-run ceiling; a hang counts as a thrown run. */
const withTimeout = (work: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Run one claim → execute → finish pass for a hosted agent. */
export async function drainRuns(deps: DrainDeps): Promise<DrainResult> {
  const client = httpClient(deps.server, deps.agentToken)
  const timeoutMs = deps.runTimeoutMs ?? 5 * 60_000
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
  let finishFailures = 0
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
    // Belt to the claim endpoint's suspenders: an empty instruction must never reach the
    // model — a primed agent with live tools and a task of nothing does arbitrary work.
    const empty = r.instruction.trim() === ""
    let ok = false
    if (!empty) {
      try {
        await withTimeout(runOne(ctx, taskFor(r)), timeoutMs)
        ok = true
      } catch {
        ok = false
      }
    }
    // Finish the CLAIMED run (not an ad-hoc record). One retry — a lost finish leaves the
    // run stuck `running` server-side, so it's worth a second attempt; a double failure is
    // counted separately, never passed off as finished work.
    const fields = {
      status: ok ? ("succeeded" as const) : ("failed" as const),
      meta: {
        outcome: empty ? "cancelled" : ok ? outcomeOf(ctx.lastResult) : "failed",
        artifact_short_id: ctx.lastResult?.shortId ?? null,
      },
    }
    const finishOk = await client
      .finishRun(r.id, fields)
      .then(() => true)
      .catch(() =>
        client
          .finishRun(r.id, fields)
          .then(() => true)
          .catch(() => false),
      )
    if (!finishOk) finishFailures += 1
    if (ok) finished += 1
    else failed += 1
  }
  return { claimed: claimed.length, finished, failed, finishFailures }
}
