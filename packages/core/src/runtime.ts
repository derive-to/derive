import type { ExecutionProvider } from "./execution"

/** A persistent workspace, not a running VM. Credentials remain connection references. */
export interface ContextRuntimeRecord {
  id: string
  org_id: string
  context_id: string
  agent_id: string
  api_url: string
  ortam_org_id: string
  ortam_user_id: string
  sandbox_id: string
  connection_id: string
  disabled_at: string | null
  created_at: string
}

export type NewContextRuntime = Omit<ContextRuntimeRecord, "disabled_at" | "created_at">

/** Accepted inputs. No tokens or environment values belong in this snapshot. */
export interface RuntimeRunInput {
  version: 1
  instruction: string
  context_id: string
  manifest: { artifact_id: string; version: number; blob_key: string }
  provider: ExecutionProvider
  model: string | null
  connection_ids: string[]
  environment_bindings: Record<string, string>
}

export type RunAttemptPhase =
  | "starting"
  | "ready"
  | "launching"
  | "running"
  | "stopping"
  | "released"
export type RuntimeSaveStatus = "pending" | "saved" | "failed"

export interface RunAttemptResult {
  version: 1
  outcome:
    | "completed"
    | "completed_with_gaps"
    | "no_change"
    | "needs_input"
    | "failed"
    | "cancelled"
  summary: string
  outputs: { kind: "artifact"; short_id: string; version: number }[]
}

/** One owner of a sandbox filesystem. Worker restarts do not create a new attempt. */
export interface RunAttemptRecord {
  id: string
  org_id: string
  run_id: string
  runtime_id: string
  attempt: number
  revision: number
  phase: RunAttemptPhase
  startup_operation_id: string | null
  /** Persisted before process submission. An unknown launch outcome cannot be retried. */
  launch_started_at: string | null
  runner_claimed_at: string | null
  process_id: string | null
  stop_operation_id: string | null
  deadline_at: string
  result_json: string | null
  save_status: RuntimeSaveStatus
  saved_snapshot_id: string | null
  released_at: string | null
  created_at: string
  updated_at: string
}

export interface RunAttemptTransition {
  phase: Exclude<RunAttemptPhase, "released">
  startup_operation_id?: string
  process_id?: string
  stop_operation_id?: string
}
