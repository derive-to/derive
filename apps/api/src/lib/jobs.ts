import {
  type AgentRecord,
  isJobOpen,
  type JobNeeds,
  type JobRecord,
  type JobResult,
  type JobStatus,
  jobResult,
  type MetaStore,
  newId,
  type Selector,
  type TriggerRecord,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import { agentWritesOff } from "./agent-writes"
import { jobsOverBudget } from "./budget"
import { creatorLeft, jobPayer } from "./job-accounts"
import { leaseUntilFor, RUN_MAX_ATTEMPTS } from "./run-lifecycle"
import { runtimeFailureReason } from "./runtime-diagnostics"
import { previousOccurrence } from "./schedule"

// THE JOB LIFECYCLE. Every unit of agent work is a job: someone asked, a trigger fired, or a
// graph job opened one of its nodes. One table, one state machine:
//
//   queued ──claim──▶ running ──report──▶ succeeded | failed | needs_you
//      ▲                 │                                   │
//      └──lease lapsed───┘ (attempt + 1, then lost)          └──answer──▶ queued
//   cancel from any open state ──▶ cancelled
//
// A follow-up on a settled job reopens it with its transcript intact; a follow-up while it is
// running is appended and the next turn sees it. The brake (`agentWrites`) binds every claim and
// every materialization, and fails closed on a settings error.

export const JOB_MAX_ATTEMPTS = RUN_MAX_ATTEMPTS

export interface JobDeps {
  meta: MetaStore
  bus?: Pick<Backplane, "publish">
  /** Is this agent a graph (its instructions page holds a workflow)? Its work opens as `graph`
   *  jobs the server walks. Absent: never (a caller with no page store). */
  isGraph?: (agent: AgentRecord) => Promise<boolean>
  /** Tell the people a job concerns that it needs them or finished (lib/notify-job.ts). Called
   *  once per transition, after the status-guarded write that made it landed; `actorId` is the
   *  person whose own action caused it, who is not told. Absent: nobody is told. */
  announce?: (job: JobRecord, actorId?: string | null) => Promise<void>
}

const iso = (ms = Date.now()) => new Date(ms).toISOString()

const wake = (
  deps: JobDeps,
  channel: string | null,
  type: "job.queued" | "job.started" | "job.progress" | "job.settled",
  job: JobRecord,
) => {
  if (!channel || !deps.bus) return
  try {
    deps.bus.publish(`u:${channel}`, {
      type,
      job_id: job.id,
      status: job.status,
      agent_id: job.agent_id,
    })
  } catch {
    // A wake is best effort: waiters re-read the store.
  }
}

/** A job just reached needs_you or a final status: tell its people. Never fails the caller. */
export const announceJob = async (
  deps: JobDeps,
  job: JobRecord,
  actorId: string | null = null,
): Promise<void> => {
  if (!deps.announce) return
  try {
    await deps.announce(job, actorId)
  } catch (e) {
    log.warn("jobs: announce failed", { job: job.id, reason: runtimeFailureReason(e) })
  }
}

// ---- The monthly budget ------------------------------------------------------------------

/** Is the person this agent's work for `askedBy` would bill past their monthly limit? */
export const overBudgetFor = async (
  meta: MetaStore,
  agent: AgentRecord,
  askedBy: string | null,
): Promise<boolean> => jobsOverBudget(meta, agent.org_id, await jobPayer(meta, agent, askedBy))

/** Is the person this job bills (its payer_id, fixed when it opened) past their limit? */
export const jobOverBudget = (meta: MetaStore, job: JobRecord): Promise<boolean> =>
  jobsOverBudget(meta, job.org_id, job.payer_id)

export const HELD_FOR_BUDGET =
  "Held: the monthly budget is used up. This job waits, and runs once the limit is raised or the month turns."

/** Say on a job, once, that it is waiting for budget rather than for a runner. A progress note,
 *  so the job stays queued and runs on its own when the budget allows. */
export const noteHeldForBudget = async (meta: MetaStore, job: JobRecord): Promise<void> => {
  const last = (await meta.listJobMessages(job.id)).at(-1)
  if (last?.meta_json && (JSON.parse(last.meta_json) as { held?: string }).held === "budget") return
  await meta.addJobMessage({
    id: newId("jm"),
    job_id: job.id,
    author_kind: "agent",
    author_id: job.agent_id,
    body_md: HELD_FOR_BUDGET,
    meta_json: JSON.stringify({ progress: true, held: "budget", server: true }),
  })
}

/** A note the server wrote about a job (held for budget, its agent's owner left), rather than
 *  something a person or the agent said. People watching the job see it; the model never
 *  reads it as part of the conversation. */
export const isServerNote = (m: { meta_json: string | null }): boolean => {
  if (!m.meta_json) return false
  try {
    const meta = JSON.parse(m.meta_json) as { server?: boolean; held?: string }
    return meta.server === true || meta.held !== undefined
  } catch {
    return false
  }
}

// ---- A person leaves ---------------------------------------------------------------------

export const OWNER_LEFT =
  "This agent's owner left the workspace, so it is paused and this job was cancelled. Ask another agent, or ask a workspace owner to take it over."

/** Someone left a workspace (removed, or their account deleted). Call it with their agents
 *  still attributed to them. The open jobs they asked are cancelled, and so are teammates'
 *  waiting jobs on the agents they created (paused by the store as the seat went), each with a
 *  short note, so every asker hears it rather than finding a job that never moves. */
export const standDownMember = async (
  deps: JobDeps,
  orgId: string,
  userId: string,
): Promise<void> => {
  const { meta } = deps
  /** Cancel every job a query finds, a page at a time, until none is left (or a page moves
   *  nothing, so a job that will not cancel cannot spin this forever). */
  const cancelAll = async (
    q: Omit<Parameters<MetaStore["listJobs"]>[0], "orgId">,
    before?: (job: JobRecord) => Promise<void>,
  ) => {
    for (;;) {
      const page = await meta.listJobs({ ...q, orgId, limit: 200 })
      let moved = 0
      for (const job of page) {
        await before?.(job)
        if ((await cancelJob(deps, job, userId))?.status === "cancelled") moved++
      }
      if (page.length < 200 || moved === 0) return
    }
  }
  await cancelAll({ askedBy: userId, status: ["queued", "running", "needs_you"] })
  const theirs = (await meta.listAgents(orgId)).filter((a) => a.created_by === userId)
  for (const agent of theirs) {
    await meta.updateAgent(agent.id, orgId, { paused_at: agent.paused_at ?? iso() })
    // On their own machine even a running job stops: its runner's key no longer works, so it
    // would only lapse and requeue on a paused agent. A Derive machine's running job settles.
    const status: JobStatus[] =
      agent.machine === "owner" ? ["queued", "running", "needs_you"] : ["queued", "needs_you"]
    await cancelAll({ agentId: agent.id, status }, async (job) => {
      await meta.addJobMessage({
        id: newId("jm"),
        job_id: job.id,
        author_kind: "agent",
        author_id: agent.id,
        body_md: OWNER_LEFT,
        meta_json: JSON.stringify({ server: true }),
      })
    })
  }
}

// ---- Who may ask -------------------------------------------------------------------------

/** A person may ask an agent when they are a member of its workspace and the agent's ask
 *  policy lets them: `workspace` lets every member ask; `invited` lets the agent's creator
 *  and workspace owners ask. */
export const canAskAgent = async (
  meta: MetaStore,
  agent: AgentRecord,
  userId: string,
): Promise<boolean> => {
  // A managed agent is a hidden principal minted for one imported paper: it runs nothing,
  // so nobody asks it.
  if (agent.managed === 1) return false
  const m = await meta.getMembership(agent.org_id, userId).catch(() => null)
  if (!m) return false
  if (agent.ask_policy === "workspace") return true
  return agent.created_by === userId || m.role === "owner"
}

/** A person may manage an agent (edit, pause, triggers, delete) when they created it or own
 *  the workspace. */
export const canManageAgent = async (
  meta: MetaStore,
  agent: AgentRecord,
  userId: string,
): Promise<boolean> => {
  // Both doors need a live seat: a creator who has left the workspace manages nothing.
  const m = await meta.getMembership(agent.org_id, userId).catch(() => null)
  if (!m) return false
  return m.role === "owner" || (agent.created_by === userId && m.role !== "viewer")
}

/** A person may act on a job (follow up, cancel, retry, answer) when they asked it or manage
 *  its agent. Seeing a job is wider (every member); steering someone else's is not. */
export const canSteerJob = async (
  meta: MetaStore,
  agent: AgentRecord,
  job: JobRecord,
  userId: string,
): Promise<boolean> =>
  (job.asked_by === userId && (await canAskAgent(meta, agent, userId))) ||
  (await canManageAgent(meta, agent, userId))

/** Whose jobs are a person's to act on (the Inbox): the ones they asked, or on agents they
 *  manage (canManageAgent's rule, read with one membership lookup). `"all"` for a workspace
 *  owner, who manages every agent; null for someone with no seat here. */
export const inboxScope = async (
  meta: MetaStore,
  orgId: string,
  userId: string,
): Promise<"all" | { askedBy: string; agentIds: string[] } | null> => {
  const seat = await meta.getMembership(orgId, userId).catch(() => null)
  if (!seat) return null
  if (seat.role === "owner") return "all"
  const own =
    seat.role === "viewer"
      ? []
      : (await meta.listAgents(orgId)).filter((a) => a.created_by === userId)
  return { askedBy: userId, agentIds: own.map((a) => a.id) }
}

// ---- Asking ------------------------------------------------------------------------------

export interface AskInput {
  agent: AgentRecord
  askedBy: string
  instruction: string
  subject?: Selector | null
  dedupeKey?: string | null
  attended?: boolean
  parentId?: string | null
  nodeId?: string | null
  kind?: "ask" | "node" | "graph"
}

/** Open a job for an agent. With a dedupe key that already names an open job, returns that
 *  job instead of opening a second one. The instruction is also the transcript's first
 *  message, so a follow-up reads as a conversation. */
export const askAgent = async (
  deps: JobDeps,
  input: AskInput,
): Promise<{ job: JobRecord; created: boolean }> => {
  const { meta } = deps
  if (input.dedupeKey) {
    const open = await meta.findOpenJobByDedupe(input.agent.id, input.askedBy, input.dedupeKey)
    if (open) return { job: open, created: false }
  }
  let job: JobRecord
  const kind =
    input.kind ?? ((await deps.isGraph?.(input.agent).catch(() => false)) ? "graph" : "ask")
  try {
    job = await meta.createJob({
      id: newId("job"),
      org_id: input.agent.org_id,
      agent_id: input.agent.id,
      kind,
      instruction: input.instruction,
      asked_by: input.askedBy,
      // Who it bills, fixed now: the budget reads this for the job's whole life.
      payer_id: await jobPayer(meta, input.agent, input.askedBy),
      attended: input.attended ? 1 : 0,
      subject_json: input.subject ? JSON.stringify(input.subject) : null,
      dedupe_key: input.dedupeKey ?? null,
      parent_id: input.parentId ?? null,
      node_id: input.nodeId ?? null,
    })
  } catch (error) {
    // Lost a race on the dedupe index: the winner is the job.
    if (input.dedupeKey) {
      const open = await meta.findOpenJobByDedupe(input.agent.id, input.askedBy, input.dedupeKey)
      if (open) return { job: open, created: false }
    }
    throw error
  }
  await meta.addJobMessage({
    id: newId("jm"),
    job_id: job.id,
    author_kind: "asker",
    author_id: input.askedBy,
    body_md: input.instruction,
  })
  wake(deps, input.agent.id, "job.queued", job)
  return { job, created: true }
}

/** A person writes to a job. Running: appended, and the next turn sees it. Otherwise the job
 *  reopens to `queued` with its transcript intact (a follow-up, or an answer to needs_you). */
export const followUpJob = async (
  deps: JobDeps,
  job: JobRecord,
  authorId: string,
  body: string,
): Promise<JobRecord> => {
  const { meta } = deps
  await meta.addJobMessage({
    id: newId("jm"),
    job_id: job.id,
    author_kind: "asker",
    author_id: authorId,
    body_md: body,
  })
  if (job.status === "running" || job.status === "queued") return job
  const reopened = await meta.updateJob(
    job.id,
    {
      status: "queued",
      needs_json: null,
      finished_at: null,
      lease_until: null,
      started_at: null,
      attempt: 0,
    },
    { status: job.status },
  )
  if (!reopened) return (await meta.getJob(job.id)) ?? job
  wake(deps, job.agent_id, "job.queued", reopened)
  return reopened
}

/** Answer a job that is waiting on a person: the answer is the next message, and the job
 *  reopens. `option` must be one of the authored options when the job offered some. */
export const answerJob = async (
  deps: JobDeps,
  job: JobRecord,
  authorId: string,
  answer: { text?: string; option?: string },
): Promise<JobRecord | { error: string }> => {
  if (job.status !== "needs_you") return { error: "this job is not waiting on anyone" }
  const needs = job.needs_json ? (JSON.parse(job.needs_json) as JobNeeds) : null
  if (answer.option && needs?.options?.length && !needs.options.includes(answer.option))
    return { error: `option must be one of: ${needs.options.join(", ")}` }
  const body = [answer.option ? `Decision: ${answer.option}` : null, answer.text ?? null]
    .filter(Boolean)
    .join("\n\n")
  if (!body) return { error: "answer needs text or an option" }
  return followUpJob(deps, job, authorId, body)
}

/** Cancel an open job and its children. `actorId` is who cancelled it (not told about it). */
export const cancelJob = async (
  deps: JobDeps,
  job: JobRecord,
  actorId: string | null = null,
): Promise<JobRecord | null> => {
  if (!isJobOpen(job.status)) return job
  const done = await deps.meta.updateJob(
    job.id,
    { status: "cancelled", finished_at: iso(), lease_until: null, dedupe_key: null },
    { status: ["queued", "running", "needs_you"] },
  )
  if (done) {
    wake(deps, done.asked_by, "job.settled", done)
    await announceJob(deps, done, actorId)
    // Children of a graph job stop with it.
    for (const child of await deps.meta.listJobs({
      orgId: done.org_id,
      parentId: done.id,
      status: ["queued", "running", "needs_you"],
      limit: 200,
    }))
      await cancelJob(deps, child)
  }
  return done
}

/** Run a failed or lost job again, as a fresh attempt with the same transcript. */
export const retryJob = async (deps: JobDeps, job: JobRecord): Promise<JobRecord | null> => {
  if (job.status !== "failed" && job.status !== "lost") return null
  const again = await deps.meta.updateJob(
    job.id,
    {
      status: "queued",
      attempt: 0,
      finished_at: null,
      started_at: null,
      lease_until: null,
      needs_json: null,
    },
    { status: job.status },
  )
  if (again) wake(deps, again.agent_id, "job.queued", again)
  return again
}

// ---- The runner side -----------------------------------------------------------------------

/** A runner pulls work for its agent: due schedule windows are materialized first (the poll IS
 *  the tick for an owner machine), then up to `limit` queued jobs are claimed, within the agent's
 *  concurrency cap. Nothing is claimed while the agent is paused or agent writes are off. */
export const pullJobs = async (
  deps: JobDeps,
  agent: AgentRecord,
  opts: { limit?: number; now?: Date } = {},
): Promise<JobRecord[]> => {
  const { meta } = deps
  const now = opts.now ?? new Date()
  const stamp = now.toISOString()
  if (!agent.seen_at || now.getTime() - new Date(agent.seen_at).getTime() > 60_000)
    await meta.touchAgentSeen(agent.id, stamp).catch(() => {})
  if (agent.paused_at || (await agentWritesOff(meta, agent.org_id))) return []
  // A Derive machine's work is dispatched to its sandbox, never pulled by another runner.
  if (agent.machine === "derive") return []
  // Its creator has left the workspace: nobody's machine or key may run it any more.
  if (await creatorLeft(meta, agent)) return []
  await materializeTriggers(
    meta,
    now,
    { agentId: agent.id, orgId: agent.org_id },
    deps.isGraph,
  ).catch((e) => log.warn("jobs: materialize on pull failed", { reason: runtimeFailureReason(e) }))
  // A job whose payer is past their monthly budget waits, queued, and says why; the claim
  // skips it and takes the next one that can run.
  const queued = (
    await meta.listJobs({ orgId: agent.org_id, agentId: agent.id, status: ["queued"], limit: 50 })
  ).filter((j) => j.attended === 0 && j.kind !== "graph")
  const held: (string | null)[] = []
  for (const payer of new Set(queued.map((j) => j.payer_id)))
    if (await jobsOverBudget(meta, agent.org_id, payer)) held.push(payer)
  for (const j of queued.filter((x) => held.includes(x.payer_id)).slice(0, 10))
    await noteHeldForBudget(meta, j)
  const running = await meta.countRunningJobs(agent.id, stamp)
  const room = Math.max(0, agent.max_concurrency - running)
  if (room === 0) return []
  const claimed = await meta.claimJobs(
    agent.id,
    Math.min(room, opts.limit ?? 10),
    leaseUntilFor(agent.max_run_ms, now.getTime()),
    stamp,
    held,
  )
  for (const j of claimed) wakeClaimed(deps, j)
  return claimed
}

/** A job was claimed (queued to running): tell its asker's open pages, which re-read it, so a
 *  margin Ask stops saying it waits for a machine the moment one takes it. */
export const wakeClaimed = (deps: JobDeps, job: JobRecord): void =>
  wake(deps, job.asked_by, "job.started", job)

/** A job served in-process (the built-in Derive) settled: tell its asker's open pages, the same
 *  event a runner's report sends, so the margin Ask shows the reply without waiting on a poll. */
export const wakeSettled = (deps: JobDeps, job: JobRecord): void =>
  wake(deps, job.asked_by, "job.settled", job)

export interface JobReport {
  /** The claim's started_at, echoed back: proof this settle belongs to the claim it names. */
  started_at: string | null
  status: "succeeded" | "failed" | "needs_you" | "progress"
  body_md?: string | null
  result?: JobResult | null
  needs?: JobNeeds | null
  cost_micro_usd?: number | null
  retryable?: boolean
  meta?: Record<string, unknown> | null
  report_artifact_id?: string | null
}

/** A runner settles or ticks the job it holds. Fenced on status and on the claim's started_at,
 *  so a superseded claim's late answer lands nowhere. Returns the job, or an error string. */
export const reportJob = async (
  deps: JobDeps,
  agent: AgentRecord,
  jobId: string,
  r: JobReport,
): Promise<{ job: JobRecord } | { error: string; status: number }> => {
  const { meta } = deps
  const job = await meta.getJob(jobId)
  if (!job || job.agent_id !== agent.id || job.org_id !== agent.org_id)
    return { error: "not found", status: 404 }
  if (job.status !== "running" || r.started_at !== job.started_at) {
    // The answer lands nowhere, but the money a superseded or cancelled run spent is real:
    // count it, or the workspace's spend undercounts exactly the runs that went wrong.
    // Only when the run was stopped under it: a resent settling report finds the job settled
    // under its own claim, and its cost is already counted.
    if (r.cost_micro_usd && (job.status === "cancelled" || job.status === "lost"))
      await meta.addJobCost(job.id, r.cost_micro_usd).catch(() => null)
    return job.status !== "running"
      ? { error: "this job is not running", status: 409 }
      : { error: "this claim has been superseded", status: 409 }
  }
  const fence = { status: "running" as JobStatus, started_at: job.started_at }
  const now = iso()

  if (r.body_md?.trim())
    await meta.addJobMessage({
      id: newId("jm"),
      job_id: job.id,
      author_kind: "agent",
      author_id: agent.id,
      body_md: r.body_md,
      meta_json: r.status === "progress" ? JSON.stringify({ progress: true }) : null,
    })

  if (r.status === "progress") {
    // On a Derive machine the lease was set past the machine's own deadline; a progress tick
    // must not pull it in, or reclaim would race a machine that is still stopping.
    const renew = leaseUntilFor(agent.max_run_ms)
    const onMachine = job.machine_phase !== null && job.machine_phase !== "released"
    const renewed = await meta.updateJob(
      job.id,
      {
        lease_until:
          onMachine && job.lease_until && job.lease_until > renew ? job.lease_until : renew,
      },
      fence,
    )
    if (!renewed) return { error: "this claim has been superseded", status: 409 }
    wake(deps, job.asked_by, "job.progress", renewed)
    return { job: renewed }
  }

  // Cost accumulates across attempts: a run that burned three attempts still cost money.
  const cost =
    r.cost_micro_usd == null ? job.cost_micro_usd : (job.cost_micro_usd ?? 0) + r.cost_micro_usd
  const result: JobResult = { ...jobResult(job), ...(r.result ?? {}) }
  const meta_json = r.meta ? JSON.stringify(r.meta) : job.meta_json
  const common = {
    cost_micro_usd: cost,
    result_json: JSON.stringify(result),
    meta_json,
    ...(r.report_artifact_id !== undefined ? { report_artifact_id: r.report_artifact_id } : {}),
  }

  let next: JobRecord | null
  if (r.status === "failed" && r.retryable && job.attempt + 1 < JOB_MAX_ATTEMPTS) {
    next = await meta.updateJob(
      job.id,
      {
        ...common,
        status: "queued",
        attempt: job.attempt + 1,
        lease_until: null,
        started_at: null,
      },
      fence,
    )
  } else if (r.status === "needs_you") {
    next = await meta.updateJob(
      job.id,
      {
        ...common,
        status: "needs_you",
        needs_json: JSON.stringify(r.needs ?? { kind: "escalation", question: r.body_md ?? "" }),
        lease_until: null,
      },
      fence,
    )
  } else {
    next = await meta.updateJob(
      job.id,
      { ...common, status: r.status, finished_at: now, lease_until: null, dedupe_key: null },
      fence,
    )
  }
  if (!next) return { error: "this claim has been superseded", status: 409 }
  wake(
    deps,
    next.status === "queued" ? next.agent_id : next.asked_by,
    next.status === "queued" ? "job.queued" : "job.settled",
    next,
  )
  // A graph node settling wakes the graph's runner, which is waiting on its children.
  if (next.parent_id && next.status !== "queued") wake(deps, next.agent_id, "job.settled", next)
  // Requeued for another attempt is not news; waiting on a person or done is.
  if (next.status !== "queued") await announceJob(deps, next)
  return { job: next }
}

// ---- The tick --------------------------------------------------------------------------------

/** Turn due schedule windows into queued jobs, one per (trigger, window). Scoped to one agent
 *  (a runner's pull) or to a list of workspaces (the deployment tick). Paused agents and
 *  workspaces with agent writes off are skipped, failing closed on a settings error. */
export const materializeTriggers = async (
  meta: MetaStore,
  now: Date,
  scope: { agentId?: string; orgId?: string; orgIds?: readonly string[] } = {},
  isGraph?: JobDeps["isGraph"],
): Promise<number> => {
  const triggers: TriggerRecord[] = scope.orgId
    ? (await meta.listTriggers(scope.orgId, scope.agentId)).filter(
        (t) => t.enabled === 1 && t.kind === "schedule" && t.cron,
      )
    : await meta.listEnabledScheduleTriggers(scope.orgIds)
  const writesOn = new Map<string, boolean>()
  const overBudget = new Map<string, boolean>()
  const agents = new Map<string, AgentRecord | null>()
  let created = 0
  for (const t of triggers) {
    if (!t.cron) continue
    const due = previousOccurrence(t.cron, t.tz ?? undefined, now)
    if (!due) continue
    const window = due.toISOString()
    // Only windows that opened after the trigger existed: a new daily schedule does not fire for
    // this morning just because it was saved this afternoon.
    if (window < t.created_at) continue
    const last = await meta.latestJobForTrigger(t.id)
    if (last?.scheduled_for && last.scheduled_for >= window) continue
    // One waiting run per schedule: while the last one is still queued (its runner is offline),
    // later windows fold into it instead of piling up to replay all at once.
    if (last?.status === "queued") continue
    if (!writesOn.has(t.org_id)) writesOn.set(t.org_id, !(await agentWritesOff(meta, t.org_id)))
    if (!writesOn.get(t.org_id)) continue
    if (!agents.has(t.agent_id)) agents.set(t.agent_id, await meta.getAgent(t.agent_id))
    const agent = agents.get(t.agent_id)
    if (!agent || agent.org_id !== t.org_id || agent.paused_at) continue
    // Past its payer's monthly budget, the window still opens its job, which waits and says
    // why. The one-waiting-run rule above keeps a held schedule from piling up.
    const payer = await jobPayer(meta, agent, null)
    if (!overBudget.has(agent.id))
      overBudget.set(agent.id, await jobsOverBudget(meta, agent.org_id, payer))
    try {
      const job = await meta.createJob({
        id: newId("job"),
        org_id: t.org_id,
        agent_id: t.agent_id,
        kind: (await isGraph?.(agent).catch(() => false)) ? "graph" : "scheduled",
        instruction: t.instruction,
        trigger_id: t.id,
        scheduled_for: window,
        subject_json: t.subject_json,
        payer_id: payer,
      })
      created += 1
      if (overBudget.get(agent.id)) await noteHeldForBudget(meta, job).catch(() => {})
    } catch {
      // Another tick won this window (the unique index): nothing to do.
    }
  }
  return created
}

/** The deployment tick: materialize due windows and reclaim lapsed leases. Platform neutral;
 *  worker.ts and node.ts call it on their own clocks. */
export const jobTick = async (
  deps: JobDeps,
  now: Date,
  orgIds?: readonly string[],
): Promise<{ materialized: number; requeued: number; lost: number }> => {
  const out = { materialized: 0, requeued: 0, lost: 0 }
  try {
    out.materialized = await materializeTriggers(deps.meta, now, { orgIds }, deps.isGraph)
  } catch (e) {
    log.warn("jobs: materialize failed", { reason: runtimeFailureReason(e) })
  }
  try {
    const { requeued, lost } = await deps.meta.reclaimStaleJobs(
      now.toISOString(),
      JOB_MAX_ATTEMPTS,
      orgIds,
    )
    out.requeued = requeued.length
    out.lost = lost.length
    for (const j of requeued) wake(deps, j.agent_id, "job.queued", j)
    for (const j of lost) {
      wake(deps, j.asked_by, "job.settled", j)
      await announceJob(deps, j)
    }
  } catch (e) {
    log.warn("jobs: reclaim failed", { reason: runtimeFailureReason(e) })
  }
  return out
}

// ---- The wire shape ----------------------------------------------------------------------------

/** A job as the API returns it: JSON columns parsed, nothing internal. */
export const jobJson = (j: JobRecord) => ({
  id: j.id,
  agent_id: j.agent_id,
  kind: j.kind,
  status: j.status,
  instruction: j.instruction,
  asked_by: j.asked_by,
  attended: j.attended === 1,
  parent_id: j.parent_id,
  node_id: j.node_id,
  trigger_id: j.trigger_id,
  subject: j.subject_json ? (JSON.parse(j.subject_json) as Selector) : null,
  needs: j.needs_json ? (JSON.parse(j.needs_json) as JobNeeds) : null,
  result: jobResult(j),
  scheduled_for: j.scheduled_for,
  started_at: j.started_at,
  finished_at: j.finished_at,
  lease_until: j.lease_until,
  attempt: j.attempt,
  cost_micro_usd: j.cost_micro_usd,
  report_artifact_id: j.report_artifact_id,
  created_at: j.created_at,
  updated_at: j.updated_at,
})
