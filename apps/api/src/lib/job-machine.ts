import {
  type AgentRecord,
  type AgentSandbox,
  type JobExecution,
  type JobRecord,
  type MetaStore,
  machineHoldsCompute,
  newId,
  parseAgentSandbox,
  type SandboxSize,
} from "@derive/core"
import { taskOptions } from "@derive-to/cli/conversation-format"
import { log } from "../log"
import { agentWritesOff } from "./agent-writes"
import { sha256 } from "./crypto"
import { turnProblem } from "./job-command"
import type { JobDeps } from "./job-policy"
import { jobOverBudget, noteHeldForBudget, reportJob, wakeClaimed, wakeSettled } from "./jobs"
import { OrtamClient } from "./ortam-client"
import { MAX_RUN_CEILING_MS, machineClock, tokenExpiryAfter } from "./run-lifecycle"
import { signWorkToken } from "./run-token"
import { cloudEnabled, connectionClient, workspaceRuntime } from "./runtime-connection"
import { runtimeFailureReason } from "./runtime-diagnostics"
import type { RuntimeConfig } from "./runtime-setup"
import { runnerRunsJobs, runtimeSetup } from "./runtime-setup"
import {
  type SandboxClient,
  type SandboxCreate,
  SandboxCreateRejected,
  SandboxRateLimited,
  SandboxRefused,
} from "./sandbox-client"

// THE DERIVE MACHINE: a sandbox the job's runner works in. An agent that keeps files shares one
// sandbox across its tasks; an agent that starts fresh gives each task its own, which stays
// parked (stopped, files kept) between that task's turns. Two sagas, each a phase plus a
// revision that fences every transition, advanced a step at a time by the tick so a crash, a
// lost response, or a second tick resumes rather than repeats:
//
//   an agent's shared sandbox  creating → provisioning → stopping → ready ⇄ busy   (→ deleting)
//   a job's turn               shared: starting → ready → launching → running → stopping → released
//                              own:    creating → provisioning → ready → … → stopping → parked
//                                      parked → starting (next turn)   parked → deleting → released
//
// A job borrows the shared sandbox (agent `busy`, the job's id in its state; the agent row lock
// keeps it to one holder). A job's own sandbox lives in its machine_json. Either way the job's
// runner reports through the ordinary report route with a `dkjob_` token that dies with the
// job; the machine never settles work itself, except to fail a job whose runner went quiet.
//
// The model account rides the runner's account fetch like any other machine's, so no login is
// moved between sandboxes.

export interface MachineDeps extends JobDeps {
  /** Signs `dkjob_` tokens; the same key agentFor verifies them with. */
  secret: string
  server: string
  config: RuntimeConfig
  fetcher?: typeof fetch
  now?: () => Date
}

const WORKDIR = "/home/ortam/work"
/** After a failed shared sandbox, wait this long times the failure count before trying again,
 *  and after this many failures in a row, fail the work that was waiting for it. */
const RETRY_BACKOFF_MS = 10 * 60_000
const MAX_SANDBOX_FAILURES = 3
/** A shared sandbox's provider-side stop timer at creation, before any job sets its own. */
const CREATE_TTL_SECONDS = 2700
const CREATE_REPLAY_MS = 24 * 60 * 60_000 - 60_000
/** A start the provider refused for now (see SandboxRateLimited). */
const WAITING = Symbol("waiting")
/** A start the provider refused outright (see SandboxRefused). */
const REFUSED = Symbol("refused")
/** How far past the asked stop time a provider's timer may land (it counts from when a resume
 *  finishes) before the turn treats the machine as misconfigured. */
const TTL_SLACK_SECONDS = 300
/** How far short of a full turn a running machine's stop timer may be and still take the next
 *  turn directly (the turn then ends at most this early, and is retried). */
const RELAUNCH_SLACK_SECONDS = 900
/** A task's parked sandbox is deleted after this long without a turn. Stopped costs nothing,
 *  so this only bounds storage and lets a session be reopened days later. */
const PARKED_TTL_MS = 7 * 24 * 60 * 60_000

interface Identity {
  organization_id: string
  user_id: string
}
interface SandboxState {
  api_url: string
  snapshot?: string
  /** Frozen from the agent's machine spec when this sandbox was reserved. */
  size?: SandboxSize
  environment?: string
  setup_script?: string
  provider?: "ortam" | "boat"
  connection_id?: string
  /** Encrypted controller credential retained until this sandbox finishes retirement. */
  credential_enc?: string | null
  account_id?: string
  actor_id?: string
  identity: Identity
  /** One id per sandbox this owner ever has: the create and delete idempotency keys carry it,
   *  so a recreate after a failure never gets the old sandbox back. */
  generation: string
  create_op?: string
  create_request?: SandboxCreate
  create_submitted_at?: string
  create_problem?: string
  stop_op?: string
  delete_op?: string
  holder?: string | null
  failures?: number
  failed_at?: string
  retired_at?: string
}
/** A job's own sandbox: its state plus the provider's id once created. */
type OwnSandbox = SandboxState & { sandbox_id?: string }
interface MachineState {
  active_at?: string
  /** One id per turn on the machine: resume and stop keys carry it, so a reopened job's next
   *  turn never gets its previous turn's operations back. */
  turn: string
  deadline_at: string
  resume_op?: string
  stop_op?: string
  process_id?: string
  launch_timeout_seconds?: number
  launch_keep_awake?: boolean
  runner_path?: string
  runner_setup?: string
  /** Present when the job runs on its own sandbox rather than its agent's shared one. */
  own?: OwnSandbox
  /** The provider refused to start a machine for now; the step waits until `until`. */
  waiting?: { reason: string; until: string }
}

const parse = <T>(s: string | null): T | null => {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

/** Does the pinned sandbox runner know job tokens? `runner run` with a `dkjob_` token arrived
 *  in CLI 0.8.0; an older pinned install would fail every job. A path with no version (a
 *  self-host's own install) is trusted. */
export { runnerRunsJobs } from "./runtime-setup"

/** Which workspaces may run Derive machines: the managed Ortam allowlist, once the sandbox
 *  runner can run jobs. */
export const machineWorkspaces = (
  config: RuntimeConfig | undefined | undefined,
): ReadonlySet<string> =>
  config?.managed?.apiKey && runnerRunsJobs(config.runnerPath, config.runnerVersion)
    ? config.managed.workspaceIds
    : new Set()

/** The one create request for a sandbox; a replay with its key must send the same. */
const sandboxRequest = (
  name: string,
  state: SandboxState,
  deps: MachineDeps,
  ttlSeconds: number,
): SandboxCreate => ({
  name,
  ...(state.size ? { size: state.size } : {}),
  ...(state.environment ? { environment: state.environment } : {}),
  auto_stop_after_seconds: ttlSeconds,
  setup_script: state.setup_script ?? runtimeSetup(deps.config.runnerArchive),
  ...(state.snapshot ? { snapshot: state.snapshot } : {}),
})

/** The sandbox keeps cleanup authority even if provider replacement races creation.
 * Same-account key rotation uses the current key; another account uses the pinned key. */
const runtimeFor = async (deps: MachineDeps, orgId: string, state: SandboxState | null) => {
  const current = await workspaceRuntime(deps.meta, deps.config, orgId)
  if (state?.api_url && state.connection_id && state.credential_enc) {
    const cn = current.connection
    const sameAccount =
      cn?.id === state.connection_id &&
      cn.toolkit === state.provider &&
      cn.broker_ref === state.account_id
    return {
      provider: state.provider ?? "ortam",
      apiUrl: state.api_url,
      connection: {
        id: state.connection_id,
        toolkit: state.provider ?? "ortam",
        secret_enc: sameAccount ? cn.secret_enc : state.credential_enc,
        broker_ref: state.account_id,
      },
    }
  }
  // Existing integration sandboxes retain their deployment credential. A workspace
  // connection cannot take ownership of their per-agent integration identity.
  return state?.api_url && !state.connection_id
    ? { provider: state.provider ?? "ortam", apiUrl: deps.config.apiUrl, connection: null }
    : current
}

/** One provider selection for normal work and retirement. Ortam scopes identity per agent. */
const clientFor = async (
  deps: MachineDeps,
  agent: AgentRecord,
  state: SandboxState | null,
): Promise<SandboxClient> => {
  const runtime = await runtimeFor(deps, agent.org_id, state)
  if (
    state &&
    (state.api_url !== runtime.apiUrl || (state.provider ?? "ortam") !== runtime.provider)
  )
    throw new Error("Sandbox belongs to a different runtime")
  if (runtime.connection) {
    if (
      state?.connection_id &&
      (state.connection_id !== runtime.connection.id ||
        state.provider !== runtime.connection.toolkit)
    )
      throw new Error("Sandbox connection changed")
    return connectionClient(runtime.connection, deps.secret, deps.fetcher)
  }
  if (!deps.config.managed?.apiKey) throw new Error("Derive machines are not configured")
  return new OrtamClient(
    deps.config.apiUrl,
    deps.config.managed.apiKey,
    sha256(JSON.stringify([agent.org_id, "agent", agent.id])),
    deps.fetcher,
  )
}

/** A new sandbox's frozen state: the workspace runtime and the agent's machine spec. */
async function newSandbox(
  deps: MachineDeps,
  agent: AgentRecord,
  spec: AgentSandbox,
  actorId: string | null | undefined,
  failures: number,
): Promise<SandboxState> {
  const runtime = await runtimeFor(deps, agent.org_id, null)
  const auth = await (await clientFor(deps, agent, null)).authenticate()
  return {
    api_url: runtime.apiUrl,
    provider: runtime.provider,
    actor_id: actorId ?? agent.created_by ?? undefined,
    setup_script: runtimeSetup(deps.config.runnerArchive),
    ...(runtime.connection
      ? {
          connection_id: runtime.connection.id,
          credential_enc: runtime.connection.secret_enc,
          account_id: runtime.connection.broker_ref,
        }
      : {}),
    identity: { organization_id: auth.organization_id, user_id: auth.user_id },
    // The agent's own machine wins; the workspace snapshot stays the default.
    ...(spec.snapshot
      ? { snapshot: spec.snapshot }
      : runtime.provider === "boat"
        ? { snapshot: (await deps.meta.getOrgSettings(agent.org_id)).boatSnapshot }
        : {}),
    ...(spec.size ? { size: spec.size } : {}),
    ...(spec.environment ? { environment: spec.environment } : {}),
    generation: newId("sbg"),
    failures,
  }
}

// ---- Provider steps both owners share ----------------------------------------------------------

/** Submit the create. The same immutable request and key, so a lost response resolves to the
 *  same sandbox. Null when the provider refused it outright. */
async function createStep(
  client: SandboxClient,
  request: SandboxCreate,
  key: string,
  state: SandboxState,
): Promise<{ sandbox_id: string; create_op: string } | null> {
  try {
    const result = await client.create(request, key, state.identity)
    return { sandbox_id: result.sandbox.id, create_op: result.operation.id }
  } catch (error) {
    if (error instanceof SandboxCreateRejected) return null
    throw error
  }
}

const createRecoveryProblem = (state: SandboxState, at: string): string | null => {
  if (state.create_problem) return state.create_problem
  if (!state.create_request)
    return "This legacy machine creation needs manual recovery: its original request is unknown."
  if (state.create_submitted_at && (state.provider ?? "ortam") === "ortam") {
    const age = Date.parse(at) - Date.parse(state.create_submitted_at)
    if (!Number.isFinite(age) || age < 0 || age >= CREATE_REPLAY_MS)
      return "This machine creation needs manual recovery: Ortam's safe replay window has ended."
  }
  return null
}

/** Retire a sandbox: submit the delete once, then wait for it. True once it is gone. */
async function deleteStep(
  client: SandboxClient,
  id: string,
  key: string,
  state: SandboxState,
  save: (deleteOp: string) => Promise<unknown>,
): Promise<boolean> {
  if (!state.delete_op) {
    if (await client.isSandboxDeleted(id, state.identity)) return true
    await save((await client.deleteSandbox(id, key, state.identity)).id)
    return false
  }
  const op = await client.operation(state.delete_op, id, "delete", state.identity)
  return (
    op.state === "succeeded" ||
    (op.state === "failed" && (await client.isSandboxDeleted(id, state.identity)))
  )
}

const iso = (deps: MachineDeps) => (deps.now?.() ?? new Date()).toISOString()

/** May this agent run on a Derive machine right now? */
const admitted = async (deps: MachineDeps, agent: AgentRecord, state: SandboxState | null) => {
  if (
    agent.machine !== "derive" ||
    agent.paused_at ||
    !(await cloudEnabled(deps.meta, deps.config, agent.org_id)) ||
    (await agentWritesOff(deps.meta, agent.org_id))
  )
    return false
  const current = (await workspaceRuntime(deps.meta, deps.config, agent.org_id)).connection
  if (!state?.connection_id) return !state?.api_url || !current
  return (
    current?.id === state.connection_id &&
    current.toolkit === state.provider &&
    (!state.account_id || current.broker_ref === state.account_id)
  )
}

/** The agent's shared-sandbox state, or null when it has none in use. */
const sharedState = (agent: AgentRecord) =>
  agent.sandbox_phase === null || agent.sandbox_phase === "failed"
    ? null
    : parse<SandboxState>(agent.sandbox_state_json)

// ---- An agent's shared sandbox ---------------------------------------------------------------

/** Advance one agent's shared sandbox a step. Returns the agent as it now stands. */
export async function advanceSandbox(
  deps: MachineDeps,
  agent: AgentRecord,
  actorId?: string | null,
): Promise<AgentRecord | null> {
  const { meta } = deps
  const state = parse<SandboxState>(agent.sandbox_state_json)
  let revision = agent.sandbox_rev
  const move = async (
    phase: AgentRecord["sandbox_phase"],
    next: Partial<SandboxState> = {},
    id?: string | null,
  ) => {
    const moved = await meta.transitionAgentSandbox(agent.id, agent.org_id, revision, {
      phase,
      state_json: JSON.stringify({ ...state, ...next }),
      ...(id !== undefined ? { sandbox_id: id } : {}),
    })
    if (moved) revision = moved.sandbox_rev
    return moved
  }
  const allowed = await admitted(deps, agent, sharedState(agent))

  if (agent.sandbox_phase === null) {
    if (!allowed || !meta.jobExecution) return agent
    const reserved = await newSandbox(
      deps,
      agent,
      parseAgentSandbox(agent.sandbox_json),
      actorId,
      state?.failures ?? 0,
    )
    return meta.jobExecution.reserve({
      agent_id: agent.id,
      org_id: agent.org_id,
      agent_rev: agent.sandbox_rev,
      global_limit: deps.config.limits.global,
      org_limit: deps.config.limits.workspace,
      state_json: JSON.stringify({
        ...reserved,
        create_request: sandboxRequest(
          `derive-${agent.id.replaceAll("_", "-")}`,
          reserved,
          deps,
          CREATE_TTL_SECONDS,
        ),
      }),
    })
  }
  if (!state) return move("failed")
  const client = await clientFor(deps, agent, state)
  const id = agent.sandbox_id
  // `failed` ends a sandbox's life with a failure counted toward the backoff; a deliberate
  // delete (spec changed, agent moved off Derive) ends with no sandbox at all.
  const failed = (failures = state.failures ?? 0) =>
    move("failed", {
      failures,
      failed_at: iso(deps),
      credential_enc: undefined,
      account_id: undefined,
      retired_at: iso(deps),
    })
  const broke = () => (state.failures ?? 0) + 1

  switch (agent.sandbox_phase) {
    case "creating": {
      const at = iso(deps)
      const problem = createRecoveryProblem(state, at)
      if (problem)
        return state.create_problem === problem
          ? agent
          : move("creating", { create_problem: problem })
      if (!state.create_request) return agent
      const replaying = !!state.create_submitted_at
      if (!replaying && !allowed) return move(null, { failures: 0 }, null)
      const submitted = replaying ? state : { ...state, create_submitted_at: at }
      if (!(await move("creating", submitted))) return null
      let created: Awaited<ReturnType<typeof createStep>>
      try {
        created = await createStep(
          client,
          state.create_request,
          `derive-agent-${agent.id}-${state.generation}-create`,
          submitted,
        )
      } catch (error) {
        if (!replaying && error instanceof SandboxRateLimited)
          await move("creating", { ...submitted, create_submitted_at: undefined })
        throw error
      }
      if (!created) {
        if (replaying)
          return move("creating", {
            ...submitted,
            create_problem:
              "This machine creation needs manual recovery: a retry was refused after an unknown outcome.",
          })
        return failed(broke())
      }
      return move(
        "provisioning",
        { ...submitted, create_op: created.create_op },
        created.sandbox_id,
      )
    }
    case "provisioning": {
      if (!id || !state.create_op)
        return move("failed", { failures: broke(), failed_at: iso(deps) })
      const op = await client.operation(state.create_op, id, "create", state.identity)
      if (op.state === "succeeded") {
        if (!allowed) return move("deleting")
        const waiting = await meta.listJobs({
          orgId: agent.org_id,
          agentId: agent.id,
          status: ["queued"],
          limit: 200,
        })
        const due = waiting.some(
          (job) =>
            job.attended !== 1 &&
            job.kind !== "graph" &&
            (!job.scheduled_for || job.scheduled_for <= iso(deps)),
        )
        return move(due ? "ready" : "stopping")
      }
      // Never race an in-flight create with deletion: a create still going is waited out.
      if (op.state === "failed") return move("deleting", { failures: broke() })
      return agent
    }
    case "stopping": {
      if (!id) return move("failed", { failures: broke(), failed_at: iso(deps) })
      const sandbox = await client.sandbox(id, state.identity)
      if (sandbox.state === "stopped")
        return move(allowed ? "ready" : "deleting", { stop_op: undefined, failures: 0 })
      // Ortam ends a sandbox whose activation failed in `failed`, which refuses every lifecycle
      // call (409). It will not come back: delete it, and the next job builds a fresh one.
      if (sandbox.state === "failed")
        return move("deleting", { stop_op: undefined, failures: broke() })
      if (!state.stop_op) {
        const op = await client.lifecycle(
          id,
          "stop",
          `derive-agent-${agent.id}-stop-${agent.sandbox_rev}`,
          state.identity,
        )
        return move("stopping", { stop_op: op.id })
      }
      const op = await client.operation(state.stop_op, id, "stop", state.identity)
      if (op.state === "failed") return move("deleting", { stop_op: undefined, failures: broke() })
      return agent
    }
    case "deleting": {
      if (!id) return state.failures ? failed() : move(null, { failures: 0 }, null)
      const gone = await deleteStep(
        client,
        id,
        `derive-agent-${agent.id}-${state.generation}-delete`,
        state,
        (deleteOp) => move("deleting", { delete_op: deleteOp }),
      )
      if (!gone) return agent
      return state.failures
        ? failed()
        : meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
            phase: null,
            state_json: JSON.stringify({ failures: 0 }),
            sandbox_id: null,
          })
    }
    default:
      return agent
  }
}

// ---- A job's turn -------------------------------------------------------------------------

/** Start a queued job's turn within capacity: on the agent's ready shared sandbox, on the
 *  job's parked own sandbox, or on a new own sandbox. Returns the job, or null (nothing done). */
async function borrow(
  deps: MachineDeps,
  agent: AgentRecord,
  job: JobRecord,
  own: OwnSandbox | null,
): Promise<JobRecord | null> {
  const store = deps.meta.jobExecution
  if (!store) return null
  const now = deps.now?.() ?? new Date()
  // An interactive session runs until its person leaves it idle; the runner parks it then.
  const clock = machineClock(
    taskOptions(job.meta_json).session ? MAX_RUN_CEILING_MS : agent.max_run_ms,
    now.getTime(),
  )
  const held = await store.borrow({
    job_id: job.id,
    org_id: job.org_id,
    agent_id: agent.id,
    ...(own ? {} : { agent_rev: agent.sandbox_rev }),
    phase: own && !own.sandbox_id ? "creating" : "starting",
    started_at: now.toISOString(),
    lease_until: new Date(clock.lease).toISOString(),
    machine_json: JSON.stringify({
      turn: newId("mjt"),
      active_at: now.toISOString(),
      deadline_at: new Date(clock.deadline).toISOString(),
      runner_path: deps.config.runnerPath,
      runner_setup: runtimeSetup(deps.config.runnerArchive),
      ...(own
        ? {
            own: {
              ...own,
              stop_op: undefined,
              ...(!own.sandbox_id
                ? {
                    create_request: sandboxRequest(
                      `derive-${job.id.replaceAll("_", "-")}`,
                      own,
                      deps,
                      ttlFor(new Date(clock.deadline).toISOString(), now.toISOString()),
                    ),
                  }
                : {}),
            },
          }
        : {}),
    } satisfies MachineState),
    global_limit: deps.config.limits.global,
    org_limit: deps.config.limits.workspace,
  })
  if (held) wakeClaimed(deps, held)
  return held
}

/** Advance one job's turn a step. */
export async function advanceMachineJob(deps: MachineDeps, job: JobRecord): Promise<void> {
  const { meta } = deps
  const agent = await meta.getAgent(job.agent_id)
  const m = parse<MachineState>(job.machine_json)
  let revision = job.machine_rev
  const move = async (
    phase: NonNullable<JobRecord["machine_phase"]>,
    next: Partial<MachineState> = {},
  ) => {
    const moved = await meta.transitionJobMachine(job.id, revision, {
      phase,
      machine_json: JSON.stringify({ ...m, ...next }),
    })
    if (moved) revision = moved.machine_rev
    return moved
  }
  const own = m?.own ?? null
  const shared = agent && !own ? parse<SandboxState>(agent.sandbox_state_json) : null
  const state: SandboxState | null = own ?? shared
  if (!agent || !m || !state || (shared && (shared.holder !== job.id || !agent.sandbox_id))) {
    // Nothing to return the machine to: finish the bookkeeping and fail the work if it is open.
    await failIfOpen(deps, agent, job, "The machine for this job is gone.")
    await move("released")
    return
  }
  const client = await clientFor(deps, agent, state)
  const at = iso(deps)
  // The provider is out of starts for now: wait, saying why, instead of asking every pass.
  if (
    m.waiting &&
    m.waiting.until > at &&
    job.status === "running" &&
    at < m.deadline_at &&
    !own?.create_problem
  )
    return
  /** The turn's compute on `sandboxId`, from when its machine came up to `stopped`. */
  const recordCompute = async (sandboxId: string, stopped: string) => {
    if (!m.active_at) return
    const usage = await client
      .usage?.(sandboxId, m.active_at, stopped, state.identity)
      .catch(() => null)
    const updated = await meta.jobExecution?.compute(job.id, job.org_id, {
      turn: m.turn,
      provider: state.provider ?? "ortam",
      ...(state.connection_id ? { connection_id: state.connection_id } : {}),
      sandbox_id: sandboxId,
      started_at: m.active_at,
      stopped_at: stopped,
      billable_seconds: usage?.billable_seconds ?? null,
      cost_micro_usd: usage?.cost_micro_usd ?? null,
    })
    if (updated) wakeSettled(deps, updated)
  }
  const startOrWait = async <T>(
    start: () => Promise<T>,
  ): Promise<T | typeof WAITING | typeof REFUSED> => {
    try {
      return await start()
    } catch (error) {
      if (error instanceof SandboxRefused) {
        const why = `boat.dev would not start a machine: ${error.message}`
        await failIfOpen(deps, agent, job, why, false)
        return REFUSED
      }
      if (!(error instanceof SandboxRateLimited)) throw error
      const until = new Date(Date.parse(at) + error.retryAfterSeconds * 1000).toISOString()
      await move(job.machine_phase ?? "starting", { waiting: { reason: error.message, until } })
      return WAITING
    }
  }
  // A job's own sandbox comes up before its first turn and is retired after its last.
  if (own) {
    const saveOwn = (next: Partial<OwnSandbox>, phase = job.machine_phase ?? "released") =>
      move(phase, { own: { ...own, ...next } })
    const ownKey = `derive-job-${job.id}-${own.generation}`
    if (job.machine_phase === "creating") {
      const problem = createRecoveryProblem(own, at)
      const hold = async (reason: string, retained = own) => {
        const held = await move("creating", {
          own: { ...retained, create_problem: reason },
          waiting: { reason, until: "9999-12-31T23:59:59.999Z" },
        })
        if (held) await failIfOpen(deps, agent, job, reason)
      }
      if (problem) return hold(problem)
      if (!own.create_request) return
      const replaying = !!own.create_submitted_at
      const shouldRetire =
        job.status !== "running" || at >= m.deadline_at || !(await admitted(deps, agent, own))
      if (shouldRetire) {
        await failIfOpen(deps, agent, job, "The task stopped before its machine was ready.")
        if (!replaying) {
          await move("released", { own: undefined, waiting: undefined })
          return
        }
      }
      const submitted = replaying ? own : { ...own, create_submitted_at: at }
      if (!(await saveOwn(submitted, "creating"))) return
      let created: Awaited<ReturnType<typeof createStep>>
      try {
        created = await createStep(client, own.create_request, `${ownKey}-create`, submitted)
      } catch (error) {
        if (error instanceof SandboxRefused) {
          if (replaying)
            return hold(
              "This machine creation needs manual recovery: a retry was refused after an unknown outcome.",
              submitted,
            )
          const released = await move("released", { own: undefined, waiting: undefined })
          if (released)
            await failIfOpen(
              deps,
              agent,
              job,
              `boat.dev would not start a machine: ${error.message}`,
              false,
            )
          return
        }
        if (!(error instanceof SandboxRateLimited)) throw error
        await move("creating", {
          own: { ...submitted, ...(!replaying ? { create_submitted_at: undefined } : {}) },
          waiting: {
            reason: error.message,
            until: new Date(Date.parse(at) + error.retryAfterSeconds * 1000).toISOString(),
          },
        })
        return
      }
      if (!created) {
        if (replaying)
          return hold(
            "This machine creation needs manual recovery: a retry was refused after an unknown outcome.",
            submitted,
          )
        const released = await move("released", { own: undefined, waiting: undefined })
        if (released)
          await failIfOpen(deps, agent, job, "Derive could not start a machine for this task.")
        return
      }
      await move("provisioning", { own: { ...submitted, ...created }, waiting: undefined })
      return
    }
    if (job.machine_phase === "provisioning") {
      if (!own.sandbox_id || !own.create_op) {
        await move("released", { own: undefined })
        return
      }
      const shouldRetire =
        job.status !== "running" || at >= m.deadline_at || !(await admitted(deps, agent, own))
      if (shouldRetire)
        await failIfOpen(deps, agent, job, "The task stopped before its machine was ready.")
      const op = await client.operation(own.create_op, own.sandbox_id, "create", own.identity)
      if (op.state === "succeeded") await move(shouldRetire ? "deleting" : "ready")
      if (op.state === "failed") {
        await failIfOpen(deps, agent, job, "The machine for this task failed to start.")
        await move("deleting")
      }
      return
    }
    if (job.machine_phase === "deleting") {
      const gone =
        !own.sandbox_id ||
        (await deleteStep(client, own.sandbox_id, `${ownKey}-delete`, own, (deleteOp) =>
          saveOwn({ delete_op: deleteOp }),
        ))
      if (gone) await move("released", { own: undefined })
      return
    }
  }

  const sandbox = own ? own.sandbox_id : agent.sandbox_id
  if (!sandbox) {
    await failIfOpen(deps, agent, job, "The machine for this job is gone.")
    await move("released", own ? { own: undefined } : {})
    return
  }
  const expired = at >= m.deadline_at
  const open = job.status === "running"
  const environment = async () => ({
    DERIVE_TOKEN: await signWorkToken(
      "job",
      deps.secret,
      `${job.id}~${Date.parse(job.started_at ?? "")}`,
      agent.id,
      agent.org_id,
      tokenExpiryAfter(Date.parse(m.deadline_at)),
    ),
    DERIVE_SERVER: deps.server,
    DERIVE_JOB_ID: job.id,
    DERIVE_RUNNER_ISOLATED: "1",
    RUNNER_TIMEOUT_MS: String(Math.max(1, Date.parse(m.deadline_at) - Date.parse(at))),
  })

  const launch = async (current: JobRecord) => {
    const claim = parse<MachineState>(current.machine_json)
    if (
      !claim?.launch_timeout_seconds ||
      !claim.runner_path ||
      !claim.runner_setup ||
      !current.started_at
    )
      return move("stopping")
    const process = await client.launch(
      sandbox,
      {
        argv: [
          "sh",
          "-c",
          `${claim.runner_setup}\nexec node "$@"`,
          "derive-runner",
          claim.runner_path,
          "runner",
          "run",
          "--cwd",
          WORKDIR,
        ],
        cwd: "/home/ortam",
        env: await environment(),
        timeout_seconds: claim.launch_timeout_seconds,
        keep_awake: claim.launch_keep_awake ?? false,
      },
      `derive-job-${m.turn}-launch`,
      state.identity,
    )
    return meta.transitionJobMachine(job.id, current.machine_rev, {
      phase: "running",
      machine_json: JSON.stringify({ ...claim, process_id: process.id }),
    })
  }

  if (
    job.machine_phase !== "stopping" &&
    (expired || !open || !(await admitted(deps, agent, state)))
  ) {
    await move("stopping")
    return
  }
  switch (job.machine_phase) {
    case "starting": {
      if (!m.resume_op) {
        const observed = await client.sandbox(sandbox, state.identity)
        // Already up (handed over from the previous turn): this turn's compute starts now.
        if (observed.state === "ready") {
          await move("ready", { active_at: m.active_at ?? at })
          return
        }
        const env = await environment()
        const op = await startOrWait(() =>
          client.lifecycle(sandbox, "resume", `derive-job-${m.turn}-resume`, state.identity, env, {
            size: state.size,
            environment: state.environment,
            ttl_seconds: ttlFor(m.deadline_at, at),
          }),
        )
        if (op === WAITING) return
        // Refused: a task's own machine stays parked with its files; a shared one goes back.
        if (op === REFUSED) {
          await move(own ? "parked" : "stopping", { waiting: undefined })
          return
        }
        await move("starting", {
          resume_op: op.id,
          active_at: m.active_at ?? at,
          waiting: undefined,
        })
        return
      }
      const op = await client.operation(m.resume_op, sandbox, "resume", state.identity)
      if (op.state === "succeeded") await move("ready")
      if (op.state === "failed") await move("stopping")
      return
    }
    case "ready": {
      const observed = await client.sandbox(sandbox, state.identity)
      // Deadline timers bound compute after resume; idle timers reset with activity and are
      // held by the runner process. Both keep the controller deadline and process timeout.
      if (
        observed.state !== "ready" ||
        observed.auto_stop_after_seconds <= 0 ||
        (client.stopTimer === "deadline" &&
          observed.auto_stop_after_seconds >
            Math.max(CREATE_TTL_SECONDS, ttlFor(m.deadline_at, at)) + TTL_SLACK_SECONDS)
      ) {
        await move("stopping")
        return
      }
      const launching = await move("launching", {
        launch_keep_awake: client.stopTimer === "idle",
        launch_timeout_seconds: Math.max(
          1,
          Math.ceil((Date.parse(m.deadline_at) - Date.parse(at)) / 1000),
        ),
      })
      // Exactly the transition's winner submits. The start is keyed to this turn, so Ortam
      // answers a repeat with the same process; a lost response still leaves `launching` until
      // the deadline stops the machine.
      if (!launching || !job.started_at) return
      await launch(launching)
      return
    }
    case "launching": {
      // Ortam returns its keyed process; Boat inspects the owned runner marker before
      // submitting. The request, including timeout, stays identical after response loss.
      await launch(job)
      return
    }
    case "running": {
      if (!m.process_id) {
        await move("stopping")
        return
      }
      const process = await client.process(sandbox, m.process_id, state.identity)
      if (process.status === "starting") {
        await launch(job)
        return
      }
      if (!["starting", "running"].includes(process.status)) await move("stopping")
      return
    }
    case "stopping": {
      const observed = await client.sandbox(sandbox, state.identity)
      // A sandbox Ortam marked `failed` (an activation that failed on resume) refuses stop with
      // a 409 forever. Give the job back to the queue and the sandbox to deletion; the next
      // turn builds a fresh one.
      if (observed.state === "failed") {
        await failIfOpen(deps, agent, job, "The machine for this job failed to start.")
        if (own) {
          await move("deleting")
          return
        }
        const released = await move("released")
        if (released && shared)
          await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
            phase: "deleting",
            state_json: JSON.stringify({
              ...shared,
              holder: null,
              failures: (shared.failures ?? 0) + 1,
            }),
          })
        return
      }
      // The task's next turn is already waiting (a follow-up, or an interrupt that ended this
      // turn): hand it the running machine instead of stopping and resuming it, which costs a
      // provider start and minutes. Only while the provider's timer still covers a full turn.
      if (own && observed.state === "ready" && !m.stop_op) {
        const after = await meta.getJob(job.id)
        const next = machineClock(
          taskOptions(job.meta_json).session ? MAX_RUN_CEILING_MS : agent.max_run_ms,
          Date.parse(at),
        )
        if (
          after?.status === "queued" &&
          observed.auto_stop_after_seconds >=
            ttlFor(new Date(next.deadline).toISOString(), at) - RELAUNCH_SLACK_SECONDS
        ) {
          await recordCompute(sandbox, at)
          await move("parked")
          return
        }
      }
      if (observed.state !== "stopped") {
        if (!m.stop_op) {
          const op = await client.lifecycle(
            sandbox,
            "stop",
            `derive-job-${m.turn}-stop`,
            state.identity,
          )
          await move("stopping", { stop_op: op.id })
          return
        }
        const op = await client.operation(m.stop_op, sandbox, "stop", state.identity)
        // A failed stop does not prove compute is gone; keep the machine until it is.
        if (op.state !== "succeeded") return
        const again = await client.sandbox(sandbox, state.identity)
        if (again.state !== "stopped") return
      }
      // Stopped, files saved. A runner that never reported fails the job so it can retry.
      await failIfOpen(deps, agent, job, "The machine stopped before the job reported back.")
      await recordCompute(sandbox, iso(deps))
      // A job's own sandbox parks with its files for the next turn, unless the task was
      // stopped for good; a shared one goes back to its agent.
      if (own) {
        const after = await meta.getJob(job.id)
        await move(after?.status === "cancelled" ? "deleting" : "parked")
        return
      }
      const released = await move("released")
      if (released && shared)
        await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
          phase: "ready",
          state_json: JSON.stringify({ ...shared, holder: null }),
        })
      return
    }
    default:
      return
  }
}

/** A provider stop timer that covers the turn's deadline with room to stop cleanly. */
const ttlFor = (deadlineAt: string, at: string) =>
  Math.max(60, Math.ceil((Date.parse(deadlineAt) - Date.parse(at)) / 1000) + 600)

async function failIfOpen(
  deps: MachineDeps,
  agent: AgentRecord | null,
  job: JobRecord,
  why: string,
  retryable = true,
) {
  const fresh = await deps.meta.getJob(job.id)
  if (!agent || fresh?.status !== "running" || fresh.started_at !== job.started_at) return
  if (fresh.started_at)
    await deps.meta.jobExecution?.claim(fresh.id, fresh.org_id, fresh.started_at)
  await reportJob(deps, agent, job.id, {
    started_at: fresh.started_at,
    status: "failed",
    body_md: why,
    retryable,
  }).catch(() => null)
}

// ---- The pass --------------------------------------------------------------------------------

/** One pass: advance every machine job, then every shared sandbox mid-lifecycle, then start
 *  queued work within the limits. Each item is isolated; a failure defers it. */
export async function machinePass(
  deps: MachineDeps,
  budget: { deadline?: number; maxRequests?: number; maxTransitions?: number } = {},
): Promise<{ advanced: number; dispatched: number }> {
  const deadline = budget.deadline ?? Date.now() + 20_000
  const maxRequests = budget.maxRequests ?? 30
  const maxTransitions = budget.maxTransitions ?? 20
  const fetcher = deps.fetcher ?? fetch
  let requests = 0
  let transitions = 0
  const canWork = () =>
    Date.now() < deadline - 1_000 && requests < maxRequests && transitions < maxTransitions
  deps = {
    ...deps,
    fetcher: (input, init) => {
      if (Date.now() >= deadline - 1_000 || requests >= maxRequests)
        throw new Error("Worker request budget exhausted")
      requests++
      const signal = AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now() - 500)))
      return fetcher(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      })
    },
  }
  const { meta } = deps
  const { limits } = deps.config
  const out = { advanced: 0, dispatched: 0 }
  const guard = async (what: string, id: string, work: () => Promise<unknown>) => {
    if (!canWork()) return
    transitions++
    try {
      await work()
      out.advanced++
    } catch (error) {
      // Ortam bodies and runner output can carry credentials: ids and a category only.
      log.warn("machine step deferred", { what, id, reason: runtimeFailureReason(error) })
    }
  }
  const advanceJob = async (job: JobRecord) => {
    let current = job
    while (canWork() && machineHoldsCompute(current.machine_phase)) {
      transitions++
      await advanceMachineJob(deps, current)
      const next = await meta.getJob(current.id)
      if (
        !next ||
        (next.machine_phase === current.machine_phase &&
          next.machine_json === current.machine_json &&
          next.status === current.status)
      )
        break
      current = next
    }
  }
  const advanceAgent = async (agent: AgentRecord, actorId?: string | null) => {
    let current = agent
    while (canWork()) {
      transitions++
      const next = await advanceSandbox(deps, current, actorId)
      if (
        !next ||
        // A retired sandbox waits for work; only dispatch reserves the next one.
        (next.sandbox_phase === null && current.sandbox_phase !== null) ||
        (next.sandbox_phase === current.sandbox_phase &&
          next.sandbox_state_json === current.sandbox_state_json)
      )
        break
      current = next
    }
  }
  for (const job of await meta.listMachineJobs(100))
    await guard("job", job.id, async () => {
      try {
        await advanceJob(job)
      } finally {
        // A pending provider observation moves to the back of the next fair scan.
        if (job.machine_phase)
          await meta.transitionJobMachine(job.id, job.machine_rev, { phase: job.machine_phase })
      }
    })
  if (!canWork()) return out
  for (const agent of await meta.listAgentsInSandboxPhase(
    ["creating", "provisioning", "stopping", "deleting"],
    100,
  ))
    await guard("sandbox", agent.id, () => advanceAgent(agent))

  if (!canWork()) return out
  // A parked sandbox no turn has used in a week is retired; its files go with it.
  for (const job of await meta.listParkedJobs(
    new Date(Date.parse(iso(deps)) - PARKED_TTL_MS).toISOString(),
    50,
  ))
    await guard("retire", job.id, () =>
      meta.transitionJobMachine(job.id, job.machine_rev, { phase: "deleting" }),
    )

  if (!canWork()) return out
  // A shared sandbox left `busy` by a job that has already let go (a crash between the job's
  // release and the agent's) goes back to ready.
  for (const agent of await meta.listAgentsInSandboxPhase(["busy"], 100))
    await guard("repair", agent.id, async () => {
      const holder = parse<SandboxState>(agent.sandbox_state_json)?.holder
      const job = holder ? await meta.getJob(holder) : null
      if (job && machineHoldsCompute(job.machine_phase)) return
      await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
        phase: "ready",
        state_json: JSON.stringify({
          ...parse<SandboxState>(agent.sandbox_state_json),
          holder: null,
        }),
      })
    })

  if (!canWork()) return out
  // A shared sandbox whose agent no longer runs on Derive is deleted; its files are gone with it.
  for (const agent of await meta.listAgentsInSandboxPhase(["ready"], 100)) {
    if (!canWork()) return out
    if (!(await admitted(deps, agent, sharedState(agent))))
      await guard("retire", agent.id, () =>
        meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
          phase: "deleting",
        }),
      )
  }

  if (!canWork()) return out
  // Sandboxes coming up count against the same ceilings as jobs holding one.
  const starting = await meta.listAgentsInSandboxPhase(
    ["creating", "provisioning", "stopping", "deleting"],
    100,
  )
  const perOrg = new Map<string, number>()
  const count = (org: string) => perOrg.set(org, (perOrg.get(org) ?? 0) + 1)
  for (const j of await meta.listMachineJobs(100)) count(j.org_id)
  for (const a of starting) count(a.org_id)
  let room = limits.global - [...perOrg.values()].reduce((n, x) => n + x, 0)
  // A shared sandbox serves one job at a time, so one try per agent; own sandboxes run in
  // parallel, one try per job.
  const tried = new Set<string>()
  for (const job of await meta.listQueuedDeriveJobs(50)) {
    if (room <= 0) break
    if ((perOrg.get(job.org_id) ?? 0) >= limits.workspace) continue
    await guard("dispatch", job.id, async () => {
      let agent = await meta.getAgent(job.agent_id)
      if (!agent) return
      if (!(await cloudEnabled(meta, deps.config, agent.org_id))) {
        const last = (await meta.listJobMessages(job.id)).at(-1)
        if (!last?.meta_json || JSON.parse(last.meta_json).held !== "compute")
          await meta.addJobMessage({
            id: newId("jm"),
            job_id: job.id,
            author_kind: "agent",
            author_id: agent.id,
            body_md:
              "This task waits for cloud compute. Ask a workspace owner to connect boat.dev in Settings → Connections.",
            meta_json: JSON.stringify({ progress: true, held: "compute", server: true }),
          })
        return
      }
      const next = (await meta.jobExecution?.turns(job.id, job.org_id))?.find(
        (turn) => turn.status === "queued" || turn.status === "running",
      )
      if (!next) return
      const execution = JSON.parse(next.execution_json) as JobExecution
      // The machine the turn was admitted with, not whatever the agent says now.
      const spec = parseAgentSandbox(execution.sandbox?.spec_json ?? agent.sandbox_json)
      const parked = parse<MachineState>(job.machine_json)?.own
      // An interactive session always gets its own machine, whatever the agent shares.
      const ownsMachine =
        spec.fresh ||
        !!taskOptions(job.meta_json).session ||
        (job.machine_phase === "parked" && !!parked)
      if (tried.has(ownsMachine ? job.id : agent.id)) return
      tried.add(ownsMachine ? job.id : agent.id)
      if (!(await admitted(deps, agent, ownsMachine ? (parked ?? null) : sharedState(agent))))
        return
      const problem = await turnProblem(
        { meta, cloud: { secret: deps.secret, config: deps.config } },
        agent,
        next.actor_id,
        execution,
      )
      if (problem) {
        const last = (await meta.listJobMessages(job.id)).at(-1)
        if (last?.body_md !== problem)
          await meta.addJobMessage({
            id: newId("jm"),
            job_id: job.id,
            author_kind: "agent",
            author_id: agent.id,
            body_md: problem,
            meta_json: JSON.stringify({ progress: true, held: "setup", server: true }),
          })
        return
      }
      // Past its payer's monthly budget: no sandbox comes up, and the job says why it waits.
      if (await jobOverBudget(meta, job)) {
        await noteHeldForBudget(meta, job)
        return
      }
      if (ownsMachine) {
        // A task's own sandbox: resume the parked one, or bring up a new one for its first turn.
        const own =
          job.machine_phase === "parked" && parked
            ? parked
            : await newSandbox(deps, agent, spec, next.actor_id, 0)
        const held = await borrow(deps, agent, job, own)
        if (!held) return
        room--
        out.dispatched++
        count(job.org_id)
        await advanceJob(held)
        return
      }
      const saved = parse<SandboxState>(agent.sandbox_state_json)
      if (
        agent.sandbox_phase === "ready" &&
        (saved?.actor_id ?? agent.created_by) !== next.actor_id
      ) {
        // Personal work files cannot become the next teammate's sandbox inputs.
        await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
          phase: "deleting",
        })
        return
      }
      // First job for this agent, or its sandbox failed: bring one up, after a backoff that
      // grows with each failure. The job waits for it; after too many, the waiting work fails.
      if (agent.sandbox_phase === null || agent.sandbox_phase === "failed") {
        const prior = parse<SandboxState>(agent.sandbox_state_json)
        const failures = prior?.failures ?? 0
        if (agent.sandbox_phase === "failed") {
          if (failures >= MAX_SANDBOX_FAILURES) {
            await failWaiting(deps, agent, "Derive could not start a machine for this agent.")
            await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
              phase: "failed",
              state_json: JSON.stringify({ ...prior, failures: 0, failed_at: iso(deps) }),
            })
            return
          }
          const since = Date.parse(iso(deps)) - Date.parse(prior?.failed_at ?? "")
          if (failures > 0 && since < RETRY_BACKOFF_MS * failures) return
          agent = await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
            phase: null,
            state_json: JSON.stringify({ failures }),
            sandbox_id: null,
          })
        }
        if (agent) {
          const starting = agent
          await advanceAgent(starting, next.actor_id).catch(async (error: unknown) => {
            // Failing before a sandbox exists (Ortam refusing the key, say) counts like any
            // failed sandbox, so the backoff and MAX_SANDBOX_FAILURES apply and the waiting
            // work is eventually told, instead of retrying every minute with no end.
            await meta.transitionAgentSandbox(starting.id, starting.org_id, starting.sandbox_rev, {
              phase: "failed",
              state_json: JSON.stringify({ failures: failures + 1, failed_at: iso(deps) }),
            })
            throw error
          })
        }
        room--
        count(job.org_id)
        return
      }
      if (agent.sandbox_phase !== "ready") return
      const held = await borrow(deps, agent, job, null)
      if (!held) return
      room--
      out.dispatched++
      count(job.org_id)
      await advanceJob(held)
    })
  }
  return out
}

/** Fail the queued work of an agent whose machine will not come up, so it shows instead of
 *  waiting silently. Not retryable: asking again tries a fresh machine. */
async function failWaiting(deps: MachineDeps, agent: AgentRecord, why: string) {
  const now = iso(deps)
  for (const job of await deps.meta.listJobs({
    orgId: agent.org_id,
    agentId: agent.id,
    status: ["queued"],
    limit: 200,
  })) {
    if (
      job.attended === 1 ||
      job.kind === "graph" ||
      (job.scheduled_for && job.scheduled_for > now)
    )
      continue
    const claimed = await deps.meta.claimJob(job.id, iso(deps), iso(deps))
    if (!claimed) continue
    if (claimed.started_at)
      await deps.meta.jobExecution?.claim(claimed.id, claimed.org_id, claimed.started_at)
    await reportJob(deps, agent, job.id, {
      started_at: claimed.started_at,
      status: "failed",
      body_md: why,
    }).catch(() => null)
  }
}

/** Keep cleanup authority until the provider confirms retirement of the agent's shared sandbox
 *  and every task's parked one. Deletion can then finish. */
export async function retireSandbox(
  deps: MachineDeps | null,
  agent: AgentRecord,
): Promise<boolean> {
  const state = parse<SandboxState>(agent.sandbox_state_json)
  const sharedDone = !state?.identity || !!state.retired_at
  if (!deps) return sharedDone
  const taskMachines = await deps.meta.retireAgentMachines(agent.org_id, agent.id)
  if (sharedDone && taskMachines === 0) return true
  if (
    sharedDone ||
    agent.sandbox_phase === "busy" ||
    ["creating", "provisioning", "stopping"].includes(agent.sandbox_phase ?? "")
  )
    return false
  await deps.meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
    phase: "deleting",
  })
  return false
}

/** The agent's machine spec changed: retire an idle shared sandbox so its next task builds one
 *  from the new spec. A sandbox in use finishes its task first and keeps the spec it started
 *  with; a task's own sandbox keeps the spec its task was admitted with. */
export async function replaceIdleSandbox(meta: MetaStore, agent: AgentRecord): Promise<void> {
  if (agent.sandbox_phase !== "ready") return
  await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
    phase: "deleting",
  })
}

/** Let a person's SSH key into a running interactive session's machine. Returns where to
 *  connect, or why not yet. Only the session's own machine is ever opened: a shared sandbox
 *  carries other tasks' files. */
export async function attachSession(
  deps: MachineDeps,
  job: JobRecord,
  publicKey: string,
): Promise<
  | ({ ok: true } & import("./sandbox-client").SandboxSshAccess)
  | { ok: false; status: 404 | 409; error: string }
> {
  const agent = await deps.meta.getAgent(job.agent_id)
  const own = parse<MachineState>(job.machine_json)?.own
  if (!agent || !taskOptions(job.meta_json).session)
    return { ok: false, status: 404, error: "This task is not an interactive session." }
  if (job.status !== "running" || job.machine_phase !== "running" || !own?.sandbox_id)
    return {
      ok: false,
      status: 409,
      error: !machineHoldsCompute(job.machine_phase)
        ? "This session is paused. Resume it first."
        : "This session is still starting.",
    }
  const client = await clientFor(deps, agent, own)
  if (!client.sshKey) return { ok: false, status: 409, error: "This machine has no SSH access." }
  return { ok: true, ...(await client.sshKey(own.sandbox_id, publicKey, own.identity)) }
}

export function sessionClaim(job: JobRecord) {
  const state = parse<MachineState>(job.machine_json)
  if (
    job.status !== "running" ||
    job.machine_phase !== "running" ||
    !job.started_at ||
    !taskOptions(job.meta_json).session ||
    !state?.own?.sandbox_id ||
    !state.turn ||
    !Number.isFinite(Date.parse(state.deadline_at)) ||
    Date.parse(state.deadline_at) <= Date.now()
  )
    return null
  return {
    startedAt: job.started_at,
    turn: state.turn,
    sandboxId: state.own.sandbox_id,
    deadlineAt: state.deadline_at,
    identity: state.own.identity,
    provider: state.own.provider,
    connectionId: state.own.connection_id,
    apiUrl: state.own.api_url,
  }
}

export async function sessionTunnelRequest(deps: MachineDeps, job: JobRecord) {
  const agent = await deps.meta.getAgent(job.agent_id)
  const own = parse<MachineState>(job.machine_json)?.own
  if (!agent || !own?.sandbox_id || !sessionClaim(job)) return null
  const client = await clientFor(deps, agent, own)
  return client.sshTunnel ? client.sshTunnel(own.sandbox_id, own.identity) : null
}

/** For the tick's callers: the pass, or nothing when this deploy has no Derive machines. */
export const machineDepsFrom = (
  meta: MetaStore,
  opts: {
    secret?: string
    server?: string
    config?: RuntimeConfig | undefined
    fetcher?: typeof fetch
    bus?: JobDeps["bus"]
    announce?: JobDeps["announce"]
  },
): MachineDeps | null =>
  opts.secret && opts.server && opts.config
    ? {
        meta,
        secret: opts.secret,
        server: opts.server,
        config: opts.config,
        fetcher: opts.fetcher,
        bus: opts.bus,
        announce: opts.announce,
      }
    : null
