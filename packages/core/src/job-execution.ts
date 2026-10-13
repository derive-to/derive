import type { JobRecord, JobResult, NewJob } from "./agent-model"
import type { ExecutionProvider } from "./execution"

/** Captured at admission. Credentials are resolved again from these account identities. */
export interface JobExecution {
  version: 1
  agent_name: string
  provider: ExecutionProvider
  model: string | null
  /** Harness reasoning level; absent on turns admitted before it existed. */
  effort?: string | null
  account_id: string | null
  connection_ids: string[]
  repositories_json: string
  environment_json: string
  skill: { artifact_id: string; version: number } | null
  sandbox: {
    provider: "boat" | "ortam"
    connection_id: string | null
    account_id: string | null
    /** The agent's machine spec at admission (core AgentSandbox), as JSON. */
    spec_json?: string | null
  }
}

export interface JobEventRecord {
  turn_id: string
  seq: number
  kind: string
  label?: string | null
  created_at: string
}

export type JobTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_you"
  | "cancelled"

export interface JobTurnRecord {
  id: string
  job_id: string
  org_id: string
  ordinal: number
  actor_id: string | null
  body_md: string
  execution_json: string
  status: JobTurnStatus
  started_at: string | null
  session_id: string | null
  checkpoint_enc: string | null
  result_json: string | null
  body_result_md: string | null
  created_at: string
  finished_at: string | null
}

export type JobTurnSummary = Omit<JobTurnRecord, "checkpoint_enc"> & { has_checkpoint: boolean }

export interface JobCommandReceipt {
  org_id: string
  source: string
  command_key: string
  actor_id: string | null
  request_hash: string
  job_id: string | null
  turn_id: string | null
  error: string | null
  status_code: number
  created_at: string
}

export type JobCommand = {
  org_id: string
  source: string
  key: string
  actor_id: string | null
  request_hash: string
  execution: JobExecution | null
  refusal?: { error: string; status: number }
} & JobCommandIntent

export type JobCommandIntent =
  | { intent: "start"; job: NewJob; body: string }
  | { intent: "follow_up"; job_id: string; body: string; interrupt?: boolean }
  | { intent: "retry"; job_id: string; body: string }
  | { intent: "answer"; job_id: string; body: string; question_id: string | null }
  | { intent: "cancel"; job_id: string }

/** Postgres owns transactions and receipts. Other stores do not advertise cloud turns. */
export interface JobExecutionStore<Agent> {
  receipt(orgId: string, source: string, key: string): Promise<JobCommandReceipt | null>
  command(input: JobCommand): Promise<{
    receipt: JobCommandReceipt
    job: JobRecord | null
    replayed: boolean
    applied: boolean
  }>
  turns(jobId: string, orgId: string): Promise<JobTurnSummary[]>
  claimed(
    jobId: string,
    orgId: string,
    startedAt: string,
  ): Promise<(JobTurnSummary & { attempt_index: number | null }) | null>
  checkpoint(
    jobId: string,
    orgId: string,
    beforeOrdinal: number,
  ): Promise<Pick<JobTurnRecord, "session_id" | "checkpoint_enc"> | null>
  events(jobId: string, orgId: string): Promise<JobEventRecord[]>
  append(
    jobId: string,
    orgId: string,
    turnId: string,
    startedAt: string,
    events: { seq: number; kind: string; label?: string }[],
  ): Promise<boolean>
  reserve(input: {
    agent_id: string
    org_id: string
    agent_rev: number
    state_json: string
    global_limit: number
    org_limit: number
  }): Promise<Agent | null>
  /** Start a queued job's turn within capacity. With `agent_rev`, it borrows the agent's shared
   *  sandbox (which must be `ready`); without, the job runs on its own sandbox, beginning at
   *  `phase` (`creating` for a new one, `starting` to resume a parked one). */
  borrow(input: {
    job_id: string
    org_id: string
    agent_id: string
    agent_rev?: number
    phase: "starting" | "creating"
    started_at: string
    lease_until: string
    machine_json: string
    global_limit: number
    org_limit: number
  }): Promise<JobRecord | null>
  claim(jobId: string, orgId: string, startedAt: string): Promise<JobTurnRecord | null>
  compute(
    jobId: string,
    orgId: string,
    receipt: NonNullable<JobResult["compute"]>[number],
  ): Promise<JobRecord | null>
  settle(input: {
    job_id: string
    org_id: string
    turn_id: string
    started_at: string
    status: "succeeded" | "failed" | "needs_you"
    body_md: string | null
    result_json: string
    needs_json: string | null
    session_id: string | null
    checkpoint_enc: string | null
    cost_micro_usd: number | null
    report_artifact_id?: string | null
  }): Promise<{ job: JobRecord; settled: boolean } | null>
}
