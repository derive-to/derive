// Hand-written declarations for job-runner.js (plain JS; this package doesn't typecheck). The
// API's jobs tests import it to run the real CLI runner against the real routes.

export interface JobRunnerCfg {
  server: string
  token: string
  agentId: string
  cwd: string
  providerName?: string | null
  model?: string | null
  agentBin?: string | null
  timeoutMs?: number
  pollMs?: number
  mock?: boolean
  localLogin?: boolean
}

export interface PulledJob {
  id: string
  started_at: string
  lease_until: string | null
  messages: { author_kind: "asker" | "agent"; body_md: string }[]
  /** The source tools the agent may call, and the model's token (tool route only) to call them. */
  tools?: { def: { name: string; description?: string; params?: unknown }; ref: string }[]
  tool_token?: string | null
  [k: string]: unknown
}

export declare class JobClient {
  constructor(cfg: JobRunnerCfg, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>)
  pull(limit?: number): Promise<{ jobs: PulledJob[] }>
}

export type RunAgent = (
  provider: unknown,
  opts: Record<string, unknown>,
) => Promise<
  | { ok: true; answer: { body_md: string; escalate?: boolean; escalation_reason?: string | null } }
  | { ok: false; error: string; retryable?: boolean }
>

export declare function loadJobRunnerConfig(
  env?: Record<string, string | undefined>,
  flags?: Record<string, string>,
): JobRunnerCfg
export declare function serveJob(
  client: JobClient,
  job: PulledJob,
  cfg: JobRunnerCfg,
  deps?: { runAgent?: RunAgent; meter?: { costUsd: number | null } },
): Promise<"succeeded" | "failed" | "needs_you" | "lost">
export declare function jobDrainPass(
  cfg: JobRunnerCfg,
  client?: JobClient,
): Promise<{ served: number; failed: number; considered: number }>
export declare function serveJobs(cfg: JobRunnerCfg): Promise<never>

export declare function loadOneJobConfig(
  env?: Record<string, string | undefined>,
  flags?: Record<string, string>,
): JobRunnerCfg & { jobId: string }
export declare function runOneJob(
  cfg: JobRunnerCfg & { jobId: string },
  client?: JobClient,
  deps?: { runAgent?: RunAgent },
): Promise<"succeeded" | "failed" | "needs_you" | "lost">
