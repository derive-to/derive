// ---- Agents, jobs, triggers, accounts (the agent model) ------------------------------------
//
// ONE object does work: an Agent. It has instructions (an artifact), what it can reach, and a
// machine: `owner` (the owner's CLI runner, or their own coding session over MCP, pulling work)
// or `derive` (an Ortam sandbox that keeps its files between jobs). Every unit of work is a Job:
// someone asked, a trigger fired, or a graph job opened one of its nodes. One lifecycle, one
// lease, one attempt counter, one transcript. A Trigger is standing configuration that creates
// jobs; an Account is the credential a machine uses to call a model.

export type AgentMachine = "owner" | "derive"
export type AgentAskPolicy = "workspace" | "invited"
export type AgentWritePolicy = "publish" | "review"

export type JobKind = "ask" | "scheduled" | "graph" | "node"
export type JobStatus =
  | "queued"
  | "running"
  | "needs_you"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost"
export const JOB_OPEN_STATUSES: readonly JobStatus[] = ["queued", "running", "needs_you"]
export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]

/** Why a job is waiting on a person. `review` = the agent asked for a look at a version;
 *  `decision` = a graph node with authored options; `escalation` = the agent declined or asked
 *  for permission; `effect` = a gated effect it will not perform without a person. */
export interface JobNeeds {
  kind: "review" | "decision" | "escalation" | "effect"
  question: string
  options?: string[]
  /** The review round, for `kind: review`. */
  review_round_id?: string
}

/** One thing a job changed in the world. A page is the kind Derive knows best; the rest are
 *  labelled links the agent reported. */
export interface JobEffect {
  kind: "page" | "pr" | "email" | "rows" | "other"
  label: string
  ref?: string
  version?: number
  url?: string
}

export interface JobResult {
  effects?: JobEffect[]
  evidence?: { label: string; url?: string; ref?: string }[]
  failure?: { reason: string; retryable: boolean }
  /** A graph job's recorded route: which node ran, which attempt, where it went next. */
  route?: { node_id: string; attempt: number; selected?: string[]; decision?: string }[]
}

export interface JobRecord {
  id: string
  org_id: string
  agent_id: string
  kind: JobKind
  parent_id: string | null
  node_id: string | null
  trigger_id: string | null
  asked_by: string | null
  attended: 0 | 1
  instruction: string
  subject_json: string | null
  status: JobStatus
  needs_json: string | null
  scheduled_for: string | null
  lease_until: string | null
  attempt: number
  started_at: string | null
  finished_at: string | null
  cost_micro_usd: number | null
  dedupe_key: string | null
  report_artifact_id: string | null
  result_json: string | null
  meta_json: string | null
  created_at: string
  updated_at: string
}
export interface NewJob {
  id: string
  org_id: string
  agent_id: string
  kind: JobKind
  instruction: string
  parent_id?: string | null
  node_id?: string | null
  trigger_id?: string | null
  asked_by?: string | null
  attended?: 0 | 1
  subject_json?: string | null
  scheduled_for?: string | null
  dedupe_key?: string | null
  meta_json?: string | null
}
/** Fields a settle, tick, or person may change. Undefined = untouched; null clears. */
export interface JobPatch {
  status?: JobStatus
  needs_json?: string | null
  lease_until?: string | null
  attempt?: number
  started_at?: string | null
  finished_at?: string | null
  cost_micro_usd?: number | null
  report_artifact_id?: string | null
  result_json?: string | null
  meta_json?: string | null
  /** Clears the dedupe key when a job settles, so the same key can open the next one. */
  dedupe_key?: string | null
}
/** Compare-and-set guard for updateJob: every named field must still equal this value. */
export interface JobExpect {
  status?: JobStatus | readonly JobStatus[]
  started_at?: string | null
  updated_at?: string
}

export type JobMessageAuthor = "asker" | "agent"
export interface JobMessageRecord {
  id: string
  job_id: string
  author_kind: JobMessageAuthor
  author_id: string
  body_md: string
  meta_json: string | null
  created_at: string
}
export interface NewJobMessage {
  id: string
  job_id: string
  author_kind: JobMessageAuthor
  author_id: string
  body_md: string
  meta_json?: string | null
}

export type AgentTriggerKind = "schedule" | "event"
export interface TriggerRecord {
  id: string
  org_id: string
  agent_id: string
  kind: AgentTriggerKind
  cron: string | null
  tz: string | null
  on_event: string | null
  instruction: string
  subject_json: string | null
  enabled: 0 | 1
  revision: number
  created_at: string
  updated_at: string
}
export interface NewTrigger {
  id: string
  org_id: string
  agent_id: string
  kind: AgentTriggerKind
  instruction: string
  cron?: string | null
  tz?: string | null
  on_event?: string | null
  subject_json?: string | null
  enabled?: 0 | 1
}

export type AccountProvider = "claude" | "codex"
export type AccountKind = "oauth" | "api_key" | "login" | "ortam_signin"
export type AccountStatus = "ready" | "needs_signin" | "not_checked"
export interface AccountRecord {
  id: string
  org_id: string
  /** The owner; `__workspace__` for a shared pool. */
  user_id: string
  provider: AccountProvider
  kind: AccountKind
  secret_enc: string | null
  hint: string | null
  status: AccountStatus
  ortam_connection_json: string | null
  created_at: string
  updated_at: string
}
export interface NewAccount {
  id: string
  org_id: string
  user_id: string
  provider: AccountProvider
  kind: AccountKind
  secret_enc?: string | null
  hint?: string | null
  status?: AccountStatus
  ortam_connection_json?: string | null
}

/** Fields an owner may change on an agent. Undefined = untouched; null clears. */
export interface AgentPatch {
  name?: string
  role?: import("./roles").Role
  description?: string | null
  instructions_artifact_id?: string | null
  machine?: AgentMachine
  sandbox_id?: string | null
  sandbox_state_json?: string | null
  account_id?: string | null
  connection_ids_json?: string | null
  repositories_json?: string | null
  environment_json?: string | null
  ask_policy?: AgentAskPolicy
  write_policy?: AgentWritePolicy
  paused_at?: string | null
  max_run_ms?: number | null
  max_concurrency?: number
  provider?: import("./execution").ExecutionProvider
  model?: string | null
}

export interface JobQuery {
  orgId: string
  agentId?: string
  status?: readonly JobStatus[]
  kind?: readonly JobKind[]
  parentId?: string
  askedBy?: string
  /** Only jobs created at or after this ISO time. */
  since?: string
  /** Keyset cursor: only jobs created strictly before this ISO time. */
  before?: string
  /** Newest first. Default 50, capped at 200 by callers. */
  limit?: number
}

export interface TriggerPatch {
  kind?: AgentTriggerKind
  cron?: string | null
  tz?: string | null
  on_event?: string | null
  instruction?: string
  subject_json?: string | null
  enabled?: 0 | 1
}

export interface AccountPatch {
  secret_enc?: string | null
  hint?: string | null
  status?: AccountStatus
  ortam_connection_json?: string | null
}

/** The store half of the agent model. One method per operation; every write is org-scoped or
 *  keyed by a globally unique id, and every multi-row claim is atomic in each dialect. */
/** The store half of the agent model. Generic over the agent row so this file never imports
 *  ports.ts (which imports it): MetaStore binds it to AgentRecord. */
export interface AgentModelStore<Agent = unknown> {
  // ---- Agents -------------------------------------------------------------------------
  /** Partial update, org-scoped. Null when the agent is not in this workspace. */
  updateAgent(id: string, orgId: string, patch: AgentPatch): Promise<Agent | null>
  /** Stamp `seen_at`, the runner's liveness mark. Callers throttle. */
  touchAgentSeen(id: string, at: string): Promise<void>

  // ---- Jobs ---------------------------------------------------------------------------
  createJob(j: NewJob): Promise<JobRecord>
  getJob(id: string): Promise<JobRecord | null>
  listJobs(q: JobQuery): Promise<JobRecord[]>
  /** Claim up to `limit` of an agent's queued jobs, oldest first: queued → running with the
   *  lease set and started_at stamped. Atomic, so overlapping claims get disjoint sets.
   *  Attended jobs are never claimed here; whoever asked serves them in-process. */
  claimJobs(agentId: string, limit: number, leaseUntil: string, now: string): Promise<JobRecord[]>
  /** Claim one queued job by id (attended turns and Derive machines). Null when it is not queued. */
  claimJob(id: string, leaseUntil: string, now: string): Promise<JobRecord | null>
  /** Patch a job, optionally compare-and-set on `expect`. Always stamps updated_at. Null when
   *  the job does not exist or an expectation no longer holds. */
  updateJob(id: string, patch: JobPatch, expect?: JobExpect): Promise<JobRecord | null>
  /** Running jobs with a live lease, the concurrency cap's count. */
  countRunningJobs(agentId: string, now: string): Promise<number>
  /** Running jobs whose lease lapsed go back to queued with attempt + 1; those already at
   *  `maxAttempts` become `lost`. Scoped to `orgIds` when given. */
  reclaimStaleJobs(
    now: string,
    maxAttempts: number,
    orgIds?: readonly string[],
  ): Promise<{ requeued: JobRecord[]; lost: JobRecord[] }>
  /** Queued jobs for agents on the Derive machine, oldest first, for the dispatch tick. */
  listQueuedDeriveJobs(limit: number, orgIds?: readonly string[]): Promise<JobRecord[]>
  /** The newest job a trigger produced, for the materializer's window dedupe. */
  latestJobForTrigger(triggerId: string): Promise<JobRecord | null>
  /** The open job holding this dedupe key, if any. */
  findOpenJobByDedupe(
    agentId: string,
    askedBy: string | null,
    dedupeKey: string,
  ): Promise<JobRecord | null>
  /** Sum of reported job cost since `since`, in micro-USD. Unknown costs are skipped. */
  sumJobCostSince(orgId: string, since: string): Promise<number>
  addJobMessage(m: NewJobMessage): Promise<JobMessageRecord>
  listJobMessages(jobId: string): Promise<JobMessageRecord[]>

  // ---- Triggers -----------------------------------------------------------------------
  createTrigger(t: NewTrigger): Promise<TriggerRecord>
  getTrigger(id: string): Promise<TriggerRecord | null>
  listTriggers(orgId: string, agentId?: string): Promise<TriggerRecord[]>
  /** Every enabled schedule trigger, scoped to `orgIds` when given. */
  listEnabledScheduleTriggers(orgIds?: readonly string[]): Promise<TriggerRecord[]>
  /** Partial update, org-scoped; bumps revision. Null when not found. */
  updateTrigger(id: string, orgId: string, patch: TriggerPatch): Promise<TriggerRecord | null>
  deleteTrigger(id: string, orgId: string): Promise<boolean>

  // ---- Accounts -----------------------------------------------------------------------
  createAccount(a: NewAccount): Promise<AccountRecord>
  getAccount(id: string): Promise<AccountRecord | null>
  /** A workspace's accounts; with `userId`, only that person's plus the shared pool. */
  listAccounts(orgId: string, userId?: string): Promise<AccountRecord[]>
  updateAccount(id: string, orgId: string, patch: AccountPatch): Promise<AccountRecord | null>
  deleteAccount(id: string, orgId: string): Promise<boolean>
}

/** The shared pool's owner id on `model_account.user_id`. */
export const WORKSPACE_ACCOUNT_OWNER = "__workspace__"

const parseJson = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
export const jobNeeds = (j: Pick<JobRecord, "needs_json">): JobNeeds | null =>
  parseJson<JobNeeds>(j.needs_json)
export const jobResult = (j: Pick<JobRecord, "result_json">): JobResult =>
  parseJson<JobResult>(j.result_json) ?? {}
export const isJobOpen = (s: JobStatus): boolean => JOB_OPEN_STATUSES.includes(s)
