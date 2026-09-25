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
  /** Null uses the deployment service integration. */
  connection_id: string | null
  /** Last applied account; retained for cleanup after the job grant changes. */
  model_connection_id: string | null
  disabled_at: string | null
  created_at: string
}

export type NewContextRuntime = Omit<
  ContextRuntimeRecord,
  "disabled_at" | "created_at" | "model_connection_id"
>

/** Accepted inputs. No tokens or environment values belong in this snapshot. */
export interface RuntimeRunInput {
  version: 1
  workflow_revision?: string
  schedule_revision?: number
  model_connection?: { id: string; revision: number }
  instruction: string
  context_id: string
  manifest: { artifact_id: string; version: number; blob_key: string }
  provider: ExecutionProvider
  model: string | null
  connection_ids: string[]
  environment_bindings: Record<string, string>
  /** Opaque secret versions pinned at enqueue; absent on legacy runs. */
  credential_revisions?: Record<string, string>
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
  /** Previous attachment identity captured by exclusive attempt admission. */
  model_source_connection_id: string | null
  model_source_user_id: string | null
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

/** Durable provisioning intent. Kept after Context deletion so cleanup can finish. */
export interface RuntimeSetupRecord {
  id: string
  org_id: string
  context_id: string
  agent_id: string
  created_by: string
  /** Null uses the deployment service integration. */
  connection_id: string | null
  api_url: string
  ortam_org_id: string
  ortam_user_id: string
  model_connection_id: string | null
  model_binding_revision: number | null
  request_json: string
  phase:
    | "queued"
    | "creating"
    | "provisioning"
    | "stopping"
    | "awaiting_connection"
    | "binding"
    | "ready"
    | "deleting"
    | "failed"
  revision: number
  sandbox_id: string | null
  create_operation_id: string | null
  stop_operation_id: string | null
  delete_operation_id: string | null
  cancelled_at: string | null
  deadline_at: string
  created_at: string
  updated_at: string
}
export type NewRuntimeSetup = Pick<
  RuntimeSetupRecord,
  | "id"
  | "org_id"
  | "context_id"
  | "agent_id"
  | "created_by"
  | "connection_id"
  | "api_url"
  | "ortam_org_id"
  | "ortam_user_id"
  | "request_json"
  | "deadline_at"
> & {
  model_connection_id?: string | null
  model_binding_revision?: number | null
}
export type RuntimeSetupChange = Pick<RuntimeSetupRecord, "phase"> &
  Partial<
    Pick<
      RuntimeSetupRecord,
      "sandbox_id" | "create_operation_id" | "stop_operation_id" | "delete_operation_id"
    >
  >

/** A reusable cloud model account. Provider credentials remain exclusively in Ortam.
 * Revoked records retain their identity for remote disconnect and runtime cleanup. */
export interface RuntimeModelConnectionRecord {
  id: string
  org_id: string
  created_by: string
  name: string
  provider: "codex" | "claude-code"
  api_url: string
  ortam_org_id: string
  ortam_user_id: string
  revision: number
  revoked_at: string | null
  created_at: string
  updated_at: string
}

/** Explicit consent for one job. Removing access retains the revision, invalidating old runs. */
export interface RuntimeModelBindingRecord {
  context_id: string
  org_id: string
  model_connection_id: string | null
  granted_by: string
  revision: number
  updated_at: string
}
