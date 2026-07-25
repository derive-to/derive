// Hand-written declarations for runner.js (plain JS by convention — this package
// doesn't typecheck). Kept in lockstep with the exports below; this is what the
// API's executor e2e tests import for a typed view of the runner surface. Only
// the externally-consumed surface is declared, not every internal export.

/** A claimed automation run, as the claim endpoint returns it. */
export interface ClaimedRun {
  id: string
  reason: string
  automation_id: string | null
  instruction: string
  targets: unknown[]
  tools: { def: { name: string; description: string }; ref: string }[]
  flags: { agentKillswitch: boolean; agentAutoEnabled: boolean }
}

/** Runner config as serveRun/runOnce consume it (a plain object, not a class). */
export interface RunnerCfg {
  server: string
  token: string
  cwd: string
  mock?: boolean
  providerName?: string
  agentBin?: string
  model?: string
  timeoutMs?: number
}

export declare class DeriveClient {
  constructor(server: string, token: string)
  claimRuns(limit?: number): Promise<ClaimedRun[]>
  finishRun(id: string, fields: Record<string, unknown>): Promise<unknown>
  readArtifact(shortId: string): Promise<string>
}

/** Execute one claimed run: prompt → model → gate → write → finish. */
export declare function serveRun(
  client: DeriveClient,
  run: ClaimedRun,
  manifest: string,
  cfg: RunnerCfg,
): Promise<void>

/** The one-shot hosted entry: claim the capability token's run, execute it, exit. */
export declare function runOnce(cfg: RunnerCfg): Promise<{ served: number; failed: number }>
