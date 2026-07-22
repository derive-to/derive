import {
  type AutonomyFlags,
  type AutonomyLevel,
  createHostedAgent,
  httpClient,
  outcomeOf,
  type RunContext,
  RunLatch,
} from "@derive/hosted-agent"
import type { MastraLanguageModel } from "@mastra/core/agent"

// The shared-lane executor: run ONE hosted agent for one task, synchronously.
// This is the "shared → HTTP invoke" half of the executor split (owner-run
// contexts still spawn `derive runner once`). The model is resolved by the host,
// never baked into the harness — Q4's provider neutrality lives here.

/** Resolve the model instance to run with. Supplied by the host so the package
 *  imports no provider SDK; throws until a provider is configured. */
export type ModelResolver = () => MastraLanguageModel

export interface InvokeRequest {
  /** The hosted agent's bearer token — every action runs as this principal. */
  agentToken: string
  /** The manifest body = the agent's system prompt (same as the runner's). */
  manifest: string
  /** Optional materialized Brandprint conventions block. */
  conventions?: string
  /** The task for this run (the ask, the draft request, the maintenance prompt). */
  task: string
  /** What woke the run (ask, mention, draft, freshness, concierge) — the ledger trigger. */
  trigger: string
  /** Autonomy level + workspace flags for the gate, loaded fresh by the API. */
  autonomy: AutonomyLevel
  flags: AutonomyFlags
}

export interface InvokeResult {
  /** The agent's final text. */
  text: string
}

/** How the agent is actually run — injectable so the HTTP surface is testable
 *  without a live model. Default calls Mastra's generate. */
export type AgentRunner = (
  agent: ReturnType<typeof createHostedAgent>,
  task: string,
) => Promise<string>

const defaultRunner: AgentRunner = async (agent, task) => {
  const res = await agent.generate(task)
  return res.text
}

export async function invokeHostedAgent(
  deps: { server: string; resolveModel: ModelResolver; run?: AgentRunner },
  req: InvokeRequest,
): Promise<InvokeResult> {
  // One client, one latch, one agent per invocation — no cross-run state.
  const client = httpClient(deps.server, req.agentToken)
  const run: RunContext = {
    client,
    latch: new RunLatch(),
    autonomy: req.autonomy,
    flags: req.flags,
  }
  const agent = createHostedAgent({
    manifest: req.manifest,
    conventions: req.conventions,
    model: deps.resolveModel(),
    run,
  })
  let text = ""
  let failed = false
  try {
    text = await (deps.run ?? defaultRunner)(agent, req.task)
  } catch (e) {
    failed = true
    // Record the failure below, then re-throw so the HTTP layer surfaces it.
    await recordRun(client, req, failed, run).catch(() => {})
    throw e
  }
  // Best-effort ledger write — observability, never a gate on the work.
  await recordRun(client, req, failed, run).catch(() => {})
  return { text }
}

async function recordRun(
  client: ReturnType<typeof httpClient>,
  req: InvokeRequest,
  failed: boolean,
  run: RunContext,
): Promise<void> {
  await client.recordRun({
    lane: "shared",
    trigger: req.trigger,
    outcome: failed ? "failed" : outcomeOf(run.lastResult),
    artifact_short_id: run.lastResult?.shortId ?? null,
  })
}
