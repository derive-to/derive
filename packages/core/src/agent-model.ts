// ---- Agents, jobs, triggers, accounts (the agent model) ------------------------------------
//
// ONE object does work: an Agent. It has instructions (an artifact), what it can reach, and a
// machine: `owner` (the owner's CLI runner, or their own coding session over MCP, pulling work)
// or `derive` (an Ortam sandbox that keeps its files between jobs). Every unit of work is a Job:
// someone asked, a trigger fired, or a graph job opened one of its nodes. One lifecycle, one
// lease, one attempt counter, one transcript. A Trigger is standing configuration that creates
// jobs; an Account is the credential a machine uses to call a model.

export type AgentMachine = "owner" | "derive"

/** The agent id the built-in Derive's jobs carry (an @Derive thread in Slack). No agent row has
 *  it; its jobs are private to their asker. */
export const DERIVE_AGENT_ID = "derive"
export type AgentAskPolicy = "workspace" | "invited"
/** Whose model account and personal secrets an agent's jobs spend: each asker's own, or the
 *  creator's, lent to everyone who may ask. Only the creator turns lending on. */
export type AgentSpendPolicy = "asker" | "creator"
/** What sharing an agent with a person grants, beyond their workspace seat: an `editor` may
 *  ask it for work; an `owner` may also manage it, as its creator does. */
export type AgentMemberRole = "editor" | "owner"
export interface AgentMemberRecord {
  agent_id: string
  org_id: string
  user_id: string
  role: AgentMemberRole
  created_at: string
}
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
  question_id?: string
  target_id?: string
  target_version?: number
  kind: "review" | "decision" | "escalation" | "effect"
  question: string
  options?: string[]
  /** The review round, for `kind: review`. */
  review_round_id?: string
  /** For a scheduled job that asked again what an earlier run of the same schedule already
   *  asked: how many runs have asked (this one included) and when the first did. */
  asked_times?: number
  first_asked_at?: string
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

/**
 * WHERE A JOB WAS ASKED FOR, when that was somewhere other than Derive: the Slack thread or
 * the GitHub event whose person is waiting on it. Stored on the job as `meta_json.origin`,
 * fixed when it opens.
 *
 * It is a reply-to address, not a principal. `asked_by` on the job row is the Derive user every
 * access decision reads; `requested_by` here is the external handle (a Slack user id, a GitHub
 * login) a reply mentions, and nothing is granted on its strength. See docs/agent-dispatch.md §4.1.1.
 */
export type JobOrigin =
  | {
      kind: "slack"
      requested_by: string
      team_id: string
      channel: string
      /** The thread the reply goes into: the mention's own ts when it started the thread. */
      thread_ts: string
      /** The mention that caused the job; part of its dedupe key. */
      message_ts: string
    }
  | {
      kind: "github"
      requested_by: string
      /** `owner/name`. */
      repository: string
      /** The pull request or issue number, when the event had one. */
      number: number | null
      delivery_id: string
      /** The pull request comment that asked, when a person mentioned the App in one. */
      comment_id?: number
      /** Derive's own reply to that comment: the one comment the outcome edits. Absent for an
       *  automation, which answers nowhere on GitHub; its agent posts for itself. */
      ack_comment_id?: number
    }

/** The `meta_json.origin` of a job, or null when it was asked for inside Derive. */
export const jobOriginOf = (metaJson: string | null | undefined): JobOrigin | null => {
  if (!metaJson) return null
  try {
    const raw = (JSON.parse(metaJson) as { origin?: unknown }).origin
    if (!raw || typeof raw !== "object") return null
    const o = raw as Record<string, unknown>
    const str = (k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : null)
    if (o.kind === "slack") {
      const requested_by = str("requested_by")
      const team_id = str("team_id")
      const channel = str("channel")
      const thread_ts = str("thread_ts")
      const message_ts = str("message_ts")
      return requested_by && team_id && channel && thread_ts && message_ts
        ? { kind: "slack", requested_by, team_id, channel, thread_ts, message_ts }
        : null
    }
    if (o.kind === "github") {
      const requested_by = str("requested_by")
      const repository = str("repository")
      const delivery_id = str("delivery_id")
      const int = (k: string) =>
        typeof o[k] === "number" && Number.isSafeInteger(o[k]) ? (o[k] as number) : null
      const number = int("number")
      const comment_id = int("comment_id")
      const ack_comment_id = int("ack_comment_id")
      return requested_by && repository && delivery_id
        ? {
            kind: "github",
            requested_by,
            repository,
            number,
            delivery_id,
            ...(comment_id ? { comment_id } : {}),
            ...(ack_comment_id ? { ack_comment_id } : {}),
          }
        : null
    }
    return null
  } catch {
    return null
  }
}

export interface JobResult {
  /** Set at admission only when every native claim is retained before execution. */
  claim_ledger_version?: 1
  /** Server-owned baseline for receipt indexes across manual retry cycles. */
  attempt_offset?: number
  /** Where the latest turn left the task's repository: the branch it was on and its commit. */
  git?: { repo: string; branch: string | null; commit: string | null }
  compute?: {
    turn: string
    provider: "ortam" | "boat"
    sandbox_id: string
    started_at: string
    stopped_at: string
    billable_seconds: number | null
    cost_micro_usd: number | null
  }[]
  /** One accepted runner report per attempt. Missing numbers stay unknown. */
  runs?: {
    attempt: number
    provider: string
    model: string
    runner_version?: string
    harness_version?: string | null
    skill?: { short_id: string; version: number }
    input_tokens: number | null
    cached_input_tokens: number | null
    output_tokens: number | null
    duration_ms: number
    model_cost_micro_usd: number | null
    harness_estimate_micro_usd?: number | null
    api_estimate_micro_usd?: number | null
    price_version?: string | null
    turn_id?: string
    actor_id?: string | null
  }[]
  effects?: JobEffect[]
  evidence?: { label: string; url?: string; ref?: string }[]
  failure?: { reason: string; retryable: boolean }
  /** One line saying what the run did, read off the row. The runner's own when it sent one,
   *  else the first sentence of its report. */
  summary?: string
  /** Closed without an answer because a later run of the same schedule asked again. */
  superseded_by?: string
  /** A graph job's recorded route: which node ran, which attempt, where it went next. */
  route?: { node_id: string; attempt: number; selected?: string[]; decision?: string }[]
}

/** An agent's shared Derive machine (agents that keep files between tasks): created lazily,
 *  then stopped between jobs. `ready` is stopped and idle; `busy` is lent to one job (its id in
 *  sandbox_state_json). Agents that start fresh give each task its own machine instead. */
export type AgentSandboxPhase =
  | "creating"
  | "provisioning"
  | "stopping"
  | "ready"
  | "busy"
  | "deleting"
  | "failed"
/** One job's turn on a sandbox: its agent's shared one, or its own.
 *
 *  shared:  starting → ready → launching → running → stopping → released (handed back)
 *  own:     creating → provisioning → ready → launching → running → stopping → parked
 *           parked → starting (the next turn resumes it)   parked → deleting → released
 *
 *  `parked` is stopped with its files kept and costs no compute; `released` holds nothing. */
export type JobMachinePhase =
  | "creating"
  | "provisioning"
  | "parked"
  | "deleting"
  | "starting"
  | "ready"
  | "launching"
  | "running"
  | "stopping"
  | "released"

/** Whether a job's machine still holds (or is returning) compute: set, and neither released
 *  nor parked, which keeps only files. */
export const machineHoldsCompute = (phase: JobMachinePhase | null | undefined): boolean =>
  !!phase && phase !== "released" && phase !== "parked"

export interface JobRecord {
  id: string
  org_id: string
  agent_id: string
  kind: JobKind
  parent_id: string | null
  node_id: string | null
  trigger_id: string | null
  asked_by: string | null
  /** Who the job bills, fixed when it opens (null = the workspace pool). The budget reads it. */
  payer_id: string | null
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
  /** Where the job stands on a Derive machine; null on owner machines. */
  machine_phase: JobMachinePhase | null
  machine_json: string | null
  machine_rev: number
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
  payer_id?: string | null
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
  meta_json?: string | null
  needs_json?: string | null
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
export type AccountKind = "oauth" | "api_key" | "login"
export type AccountStatus = "ready" | "not_checked" | "connecting" | "needs_attention"
export interface AccountRecord {
  id: string
  org_id: string
  /** The owner; `__workspace__` for a shared pool. */
  user_id: string
  provider: AccountProvider
  kind: AccountKind
  secret_enc: string | null
  /** What its owner calls it ("Work Max plan"); null shows the provider name. */
  name: string | null
  hint: string | null
  status: AccountStatus
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
  name?: string | null
  hint?: string | null
  status?: AccountStatus
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
  spend_policy?: AgentSpendPolicy
  write_policy?: AgentWritePolicy
  paused_at?: string | null
  max_run_ms?: number | null
  max_concurrency?: number
  provider?: import("./execution").ExecutionProvider
  model?: string | null
  effort?: string | null
  sandbox_json?: string | null
}

export interface JobQuery {
  orgId: string
  agentId?: string
  status?: readonly JobStatus[]
  kind?: readonly JobKind[]
  parentId?: string
  askedBy?: string
  /** Only jobs opened by this trigger. Null selects work without a trigger. */
  triggerId?: string | null
  /** Only the job whose report page is this artifact. */
  reportArtifactId?: string
  /** Only jobs whose subject_json is one of these (a page's selector, by short id or id). */
  subjectJson?: readonly string[]
  /** Only jobs this person asked, or on one of these agents (the inbox's "mine"). */
  askedByOrAgent?: { askedBy: string; agentIds: readonly string[] }
  /** The person listing. When set (even to ""), the built-in Derive's jobs are kept only
   *  when they asked them: those answers were read with the asker's own permissions. */
  viewer?: string
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
  /** Who holds it: a person, or WORKSPACE_ACCOUNT_OWNER once it is shared. */
  user_id?: string
  kind?: AccountKind
  name?: string | null
  secret_enc?: string | null
  hint?: string | null
  status?: AccountStatus
}

/** The store half of the agent model. One method per operation; every write is org-scoped or
 *  keyed by a globally unique id, and every multi-row claim is atomic in each dialect. */
/** The store half of the agent model. Generic over the agent row so this file never imports
 *  ports.ts (which imports it): MetaStore binds it to AgentRecord. */
export interface AgentModelStore<Agent = unknown> {
  /** The people an agent is shared with. Its creator holds it without a row. */
  listAgentMembers(agentId: string, orgId: string): Promise<AgentMemberRecord[]>
  /** One person's shares across a workspace's agents. */
  listAgentGrants(orgId: string, userId: string): Promise<AgentMemberRecord[]>
  /** Share an agent with a person at `role`, or stop sharing it with them (null). */
  setAgentMember(
    agentId: string,
    orgId: string,
    userId: string,
    role: AgentMemberRole | null,
  ): Promise<void>
  listAgentArtifactPins(
    agentId: string,
    orgId: string,
  ): Promise<{ agent_id: string; org_id: string; artifact_id: string }[]>
  setAgentArtifactPin(
    agentId: string,
    orgId: string,
    artifactId: string,
    pinned: boolean,
  ): Promise<void>
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
  claimJobs(
    agentId: string,
    limit: number,
    leaseUntil: string,
    now: string,
    /** Jobs billing these payers stay queued (held for budget). `null` names the pool. */
    heldPayers?: readonly (string | null)[],
  ): Promise<JobRecord[]>
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
  /** Sum of reported job cost since `since`, in micro-USD. Unknown costs are skipped. With
   *  `payer`, only the jobs whose payer_id is that person. */
  sumJobCostSince(orgId: string, since: string, payer?: string): Promise<number>
  /** Add spend to a job in one statement, whatever its status: a late report's cost is real. */
  addJobCost(id: string, microUsd: number): Promise<void>
  /** A person has left a workspace (`orgId`) or Derive (`orgId` null): pause the agents they
   *  created there, in the same write as the seat going, so nothing runs for them in between.
   *  Their open jobs are cancelled by lib/jobs.ts standDownMember, which wakes the askers. */
  pauseAgentsCreatedBy(userId: string, orgId: string | null, now: string): Promise<void>
  /** A person's account is being deleted: their agents' keys die (the stored hash becomes one
   *  no key can produce) and the agents stay paused, BEFORE created_by is cleared, since an
   *  agent with no creator would otherwise authenticate again. */
  revokeAgentsCreatedBy(userId: string, now: string): Promise<void>

  // ---- Derive machines ------------------------------------------------------------------
  /** Compare-and-set the agent's sandbox state on sandbox_rev; null when another writer won. */
  transitionAgentSandbox(
    id: string,
    orgId: string,
    expectRev: number,
    next: {
      phase: AgentSandboxPhase | null
      state_json?: string | null
      sandbox_id?: string | null
    },
  ): Promise<Agent | null>
  /** Agents whose sandbox is mid-lifecycle (not null, ready, busy, or failed). */
  listAgentsInSandboxPhase(phases: readonly AgentSandboxPhase[], limit: number): Promise<Agent[]>
  /** Compare-and-set a job's machine state on machine_rev; null when another writer won. */
  transitionJobMachine(
    id: string,
    expectRev: number,
    next: { phase: JobMachinePhase; machine_json?: string | null },
  ): Promise<JobRecord | null>
  /** Jobs still holding or returning a sandbox (machine_phase set, not parked or released). */
  listMachineJobs(limit: number): Promise<JobRecord[]>
  /** Jobs whose own sandbox is parked and whose last activity is before `before`. */
  listParkedJobs(before: string, limit: number): Promise<JobRecord[]>
  /** Move every parked task machine of an agent to deletion and count the agent's task
   *  machines not yet released (deletion waits for zero). */
  retireAgentMachines(orgId: string, agentId: string): Promise<number>
  /** Graph jobs the server is walking or about to start (queued or running). */
  listOpenGraphJobs(limit: number): Promise<JobRecord[]>
  addJobMessage(m: NewJobMessage): Promise<JobMessageRecord>
  listJobMessages(jobId: string): Promise<JobMessageRecord[]>
  /** The newest in-process @Derive answers (author `derive`) across every job, newest first:
   *  the sample the operator's model timings fold. Runner reports and server notes are not
   *  model calls this deploy made, so they are left out rather than crowding the sample.
   *  Deliberately unscoped (a question about the deploy, not a workspace), so operator-only
   *  at the route; `body_md` is left out of the projection. */
  listRecentAgentJobMessages(
    limit: number,
  ): Promise<Pick<JobMessageRecord, "job_id" | "created_at" | "meta_json">[]>

  // ---- Triggers -----------------------------------------------------------------------
  createTrigger(t: NewTrigger): Promise<TriggerRecord>
  getTrigger(id: string): Promise<TriggerRecord | null>
  listTriggers(orgId: string, agentId?: string): Promise<TriggerRecord[]>
  /** Every enabled schedule trigger, scoped to `orgIds` when given. */
  listEnabledScheduleTriggers(orgIds?: readonly string[]): Promise<TriggerRecord[]>
  /** Every enabled event trigger: few, and a delivery filters them by what they name. */
  listEnabledEventTriggers(): Promise<TriggerRecord[]>
  /** Partial update, org-scoped; bumps revision. Null when not found. */
  updateTrigger(id: string, orgId: string, patch: TriggerPatch): Promise<TriggerRecord | null>
  deleteTrigger(id: string, orgId: string): Promise<boolean>

  // ---- Accounts -----------------------------------------------------------------------
  createAccount(a: NewAccount): Promise<AccountRecord>
  getAccount(id: string): Promise<AccountRecord | null>
  /** A workspace's accounts; with `userId`, only that person's plus the shared pool. */
  listAccounts(orgId: string, userId?: string): Promise<AccountRecord[]>
  /** With an expected ciphertext, replace a credential only if it is still current. */
  updateAccount(
    id: string,
    orgId: string,
    patch: AccountPatch,
    expectSecretEnc?: string | null,
  ): Promise<AccountRecord | null>
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
/** Keep the first ask and total ask count when a schedule replaces an open question. */
export const questionHistory = (
  needs: JobNeeds,
  earlier: readonly Pick<JobRecord, "needs_json" | "updated_at">[],
): JobNeeds => {
  const next = { ...needs }
  for (const job of earlier) {
    const prior = jobNeeds(job)
    next.asked_times = Math.max(next.asked_times ?? 1, (prior?.asked_times ?? 1) + 1)
    const first = prior?.first_asked_at ?? job.updated_at
    if (!next.first_asked_at || first < next.first_asked_at) next.first_asked_at = first
  }
  return next
}
export const jobResult = (j: Pick<JobRecord, "result_json">): JobResult =>
  parseJson<JobResult>(j.result_json) ?? {}

/** The one line a row shows for a run: the first sentence of what the agent reported, with
 *  markdown dropped. A heading that only labels the report ("## Verdict") is skipped for the
 *  paragraph after it; rules, tables and images are skipped too. Only the head of the body is
 *  read, so a runner cannot make this slow with a long one. */
export const JOB_SUMMARY_MAX = 200
const SUMMARY_READ = 4_000
const ABBREVIATIONS =
  /(?:\b(?:e\.g|i\.e|vs|etc|approx|a\.m|p\.m|no|dr|mr|mrs|ms|st|fig|jr|sr)|\b[A-Za-z])\.$/i

/** The visible words of one markdown line. */
function plainLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_](?=\S)/g, "$1")
    .replace(/(\S)[*_](?=[\s.,;:!?)]|$)/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim()
}

export function jobSummaryOf(bodyMd: string | null | undefined): string | undefined {
  const lines = (bodyMd ?? "").slice(0, SUMMARY_READ).split("\n")
  const paragraphs: { heading: boolean; text: string }[] = []
  let current: string[] = []
  let heading = false
  let fence = false
  const close = () => {
    const text = plainLine(current.join(" "))
    if (text) paragraphs.push({ heading, text })
    current = []
    heading = false
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (!line) {
      close()
      continue
    }
    // A line of = or - under one line of text makes that line a heading.
    if (current.length === 1 && /^(?:={3,}|-{3,})$/.test(line)) {
      heading = true
      continue
    }
    // Rules and table rows carry no words of their own.
    if (/^(?:[-*_]\s*){3,}$/.test(line) || line.startsWith("|")) continue
    const item = /^(?:[-*+]|\d+[.)])\s+/.test(line)
    if (item && current.length) close()
    if (!current.length && /^#{1,6}\s/.test(line)) heading = true
    current.push(
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^(?:[-*+]|\d+[.)])\s+/, ""),
    )
    if (paragraphs.length > 1) break
  }
  close()
  const first = paragraphs[0]
  if (!first) return undefined
  // A heading that only labels the report ("Verdict", "By industry") gives way to the
  // paragraph under it; one that says something ("357 orgs had sessions.") is the line.
  const label = first.heading && !/[.!?]/.test(first.text) && first.text.split(" ").length <= 4
  const pick = label && paragraphs[1] ? paragraphs[1].text : first.text
  let line = pick
  const re = /[.?!](?=\s|$)/g
  for (let m = re.exec(pick); m; m = re.exec(pick)) {
    const head = pick.slice(0, m.index + 1)
    if (head.length >= 12 && !ABBREVIATIONS.test(head)) {
      line = head
      break
    }
  }
  return line.length > JOB_SUMMARY_MAX ? `${line.slice(0, JOB_SUMMARY_MAX - 1).trimEnd()}…` : line
}
export const isJobOpen = (s: JobStatus): boolean => JOB_OPEN_STATUSES.includes(s)
