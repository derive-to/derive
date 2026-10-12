import { type AgentRecord, type JobRecord, jobResult, type MetaStore, newId } from "@derive/core"
import type { AppDeps } from "../context"
import { log } from "../log"
import { agentWritesOff } from "./agent-writes"
import { sha256 } from "./crypto"
import {
  type JobDeps,
  jobOverBudget,
  noteHeldForBudget,
  reportJob,
  wakeClaimed,
  wakeSettled,
} from "./jobs"
import { OrtamClient } from "./ortam-client"
import { RUN_LEASE_MS, RUN_TIMEOUT_MS } from "./run-lifecycle"
import { signWorkToken } from "./run-token"
import { cloudEnabled, connectionClient, workspaceRuntime } from "./runtime-connection"
import { runtimeFailureReason } from "./runtime-diagnostics"
import { INSTALL_RUNTIME_RUNNER, runnerRunsJobs } from "./runtime-setup"
import type { SandboxClient } from "./sandbox-client"

// THE DERIVE MACHINE: one Ortam sandbox per agent, kept stopped between jobs so its files
// persist. Two sagas, each a phase plus a revision that fences every transition, advanced a
// step at a time by the tick so a crash, a lost response, or a second tick resumes rather than
// repeats:
//
//   the agent's sandbox   creating → provisioning → stopping → ready ⇄ busy   (→ deleting → failed)
//   a job's turn on it    starting → ready → launching → running → stopping → released
//
// A job borrows the sandbox (agent `busy`, the job's id in its state) and a unique index on
// job(agent_id) for unreleased machine jobs means only one job ever holds it. The job's own
// runner reports through the ordinary report route with a `dkjob_` token that dies with the
// job; the machine never settles work itself, except to fail a job whose runner went quiet.
//
// The model account rides the runner's account fetch like any other machine's, so no login is
// moved between sandboxes.

export interface MachineDeps extends JobDeps {
  /** Signs `dkjob_` tokens; the same key agentFor verifies them with. */
  secret: string
  server: string
  config: NonNullable<AppDeps["runtime"]>
  fetcher?: typeof fetch
  now?: () => Date
}

/** Global and per-workspace ceilings on jobs holding a sandbox at once. */
const GLOBAL_LIMIT = 10
const ORG_LIMIT = 3
const WORKDIR = "/home/ortam/work"
/** After a failed sandbox, wait this long times the failure count before trying again, and
 *  after this many failures in a row, fail the work that was waiting for it. */
const RETRY_BACKOFF_MS = 10 * 60_000
const MAX_SANDBOX_FAILURES = 3

interface Identity {
  organization_id: string
  user_id: string
}
interface SandboxState {
  api_url: string
  snapshot?: string
  provider?: "ortam" | "boat"
  connection_id?: string
  /** Encrypted controller credential retained until this sandbox finishes retirement. */
  credential_enc?: string | null
  account_id?: string
  identity: Identity
  /** One id per sandbox this agent ever has: the create and delete idempotency keys carry it,
   *  so a recreate after a failure never gets the old sandbox back. */
  generation: string
  create_op?: string
  stop_op?: string
  delete_op?: string
  holder?: string | null
  failures?: number
  failed_at?: string
}
interface MachineState {
  active_at?: string
  /** One id per turn on the machine: resume and stop keys carry it, so a reopened job's next
   *  turn never gets its previous turn's operations back. */
  turn: string
  deadline_at: string
  resume_op?: string
  stop_op?: string
  process_id?: string
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
export const machineWorkspaces = (config: AppDeps["runtime"] | undefined): ReadonlySet<string> =>
  config?.managed?.apiKey && runnerRunsJobs(config.runnerPath, config.runnerVersion)
    ? config.managed.workspaceIds
    : new Set()

/** The one create request for an agent's sandbox; a replay with its key must send the same. */
const sandboxRequest = (agent: AgentRecord, state: SandboxState) => ({
  name: `derive-${agent.id.replaceAll("_", "-")}`,
  size: "small",
  auto_stop_after_seconds: 1200,
  setup_script: INSTALL_RUNTIME_RUNNER,
  ...(state.snapshot ? { snapshot: state.snapshot } : {}),
})

/** The sandbox keeps cleanup authority even if provider replacement races creation.
 * Same-account key rotation uses the current key; another account uses the pinned key. */
const runtimeForAgent = async (deps: MachineDeps, agent: AgentRecord) => {
  const state = parse<SandboxState>(agent.sandbox_state_json)
  const current = await workspaceRuntime(deps.meta, deps.config, agent.org_id)
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
const clientFor = async (deps: MachineDeps, agent: AgentRecord): Promise<SandboxClient> => {
  const runtime = await runtimeForAgent(deps, agent)
  const state = parse<SandboxState>(agent.sandbox_state_json)
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

const iso = (deps: MachineDeps) => (deps.now?.() ?? new Date()).toISOString()

/** May this agent hold a sandbox right now? */
const admitted = async (deps: MachineDeps, agent: AgentRecord) => {
  if (
    agent.machine !== "derive" ||
    agent.paused_at ||
    !(await cloudEnabled(deps.meta, deps.config, agent.org_id)) ||
    (await agentWritesOff(deps.meta, agent.org_id))
  )
    return false
  if (agent.sandbox_phase === null || agent.sandbox_phase === "failed") return true
  const state = parse<SandboxState>(agent.sandbox_state_json)
  const current = (await workspaceRuntime(deps.meta, deps.config, agent.org_id)).connection
  if (!state?.connection_id) return !state?.api_url || !current
  return (
    current?.id === state.connection_id &&
    current.toolkit === state.provider &&
    (!state.account_id || current.broker_ref === state.account_id)
  )
}

// ---- The agent's sandbox --------------------------------------------------------------------

/** Advance one agent's sandbox a step. Returns the agent as it now stands. */
export async function advanceSandbox(
  deps: MachineDeps,
  agent: AgentRecord,
): Promise<AgentRecord | null> {
  const { meta } = deps
  const state = parse<SandboxState>(agent.sandbox_state_json)
  const move = (
    phase: AgentRecord["sandbox_phase"],
    next: Partial<SandboxState> = {},
    id?: string,
  ) =>
    meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
      phase,
      state_json: JSON.stringify({ ...state, ...next }),
      ...(id !== undefined ? { sandbox_id: id } : {}),
    })
  const allowed = await admitted(deps, agent)
  const runtime = await runtimeForAgent(deps, agent)

  if (agent.sandbox_phase === null) {
    if (!allowed) return agent
    const client = await clientFor(deps, agent)
    const auth = await client.authenticate()
    const prior = parse<SandboxState>(agent.sandbox_state_json)
    return meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
      phase: "creating",
      state_json: JSON.stringify({
        api_url: runtime.apiUrl,
        provider: runtime.provider,
        ...(runtime.connection
          ? {
              connection_id: runtime.connection.id,
              credential_enc: runtime.connection.secret_enc,
              account_id: runtime.connection.broker_ref,
            }
          : {}),
        identity: { organization_id: auth.organization_id, user_id: auth.user_id },
        ...(runtime.provider === "boat"
          ? { snapshot: (await meta.getOrgSettings(agent.org_id)).boatSnapshot }
          : {}),
        generation: newId("sbg"),
        failures: prior?.failures ?? 0,
      } satisfies SandboxState),
    })
  }
  if (!state) return move("failed")
  if (state.api_url !== runtime.apiUrl || (state.provider ?? "ortam") !== runtime.provider)
    throw new Error("Sandbox belongs to a different runtime")
  const client = await clientFor(deps, agent)
  const id = agent.sandbox_id
  // `failed` ends a sandbox's life; only a failed operation counts toward the backoff, not a
  // deliberate delete (an agent moved off Derive, admission withdrawn).
  const failed = () =>
    move("failed", { failed_at: iso(deps), credential_enc: undefined, account_id: undefined })
  const broke = () => (state.failures ?? 0) + 1

  switch (agent.sandbox_phase) {
    case "creating": {
      // Always resolve the create, even once admission is gone: a create whose response was
      // lost may have made a sandbox, and only the same key finds it to delete.
      // The same immutable request and key, so a lost response resolves to the same sandbox.
      const result = await client.create(
        sandboxRequest(agent, state),
        `derive-agent-${agent.id}-${state.generation}-create`,
        state.identity,
      )
      return move("provisioning", { create_op: result.operation.id }, result.sandbox.id)
    }
    case "provisioning": {
      if (!id || !state.create_op)
        return move("failed", { failures: broke(), failed_at: iso(deps) })
      const op = await client.operation(state.create_op, id, "create", state.identity)
      if (op.state === "succeeded") return move(allowed ? "stopping" : "deleting")
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
      if (!id) return failed()
      if (!state.delete_op) {
        if (await client.isSandboxDeleted(id, state.identity)) return failed()
        const op = await client.deleteSandbox(
          id,
          `derive-agent-${agent.id}-${state.generation}-delete`,
          state.identity,
        )
        return move("deleting", { delete_op: op.id })
      }
      const op = await client.operation(state.delete_op, id, "delete", state.identity)
      if (
        op.state === "succeeded" ||
        (op.state === "failed" && (await client.isSandboxDeleted(id, state.identity)))
      )
        return failed()
      return agent
    }
    default:
      return agent
  }
}

// ---- A job's turn -------------------------------------------------------------------------

/** Lend a ready sandbox to a queued job. Returns the job holding it, or null (nothing done). */
async function borrow(
  deps: MachineDeps,
  agent: AgentRecord,
  job: JobRecord,
): Promise<JobRecord | null> {
  const { meta } = deps
  if (agent.sandbox_phase !== "ready") return null
  if (job.machine_phase !== null && job.machine_phase !== "released") return null
  const state = parse<SandboxState>(agent.sandbox_state_json)
  const busy = await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
    phase: "busy",
    state_json: JSON.stringify({ ...state, holder: job.id }),
  })
  if (!busy) return null
  const giveBack = () =>
    meta.transitionAgentSandbox(agent.id, agent.org_id, busy.sandbox_rev, {
      phase: "ready",
      state_json: JSON.stringify({ ...state, holder: null }),
    })
  const now = deps.now?.() ?? new Date()
  // A job's whole turn on the machine, boot to stop. The lease outlasts the deadline (and the
  // job's token), so reclaim never races a machine that is still stopping.
  const deadline = new Date(now.getTime() + RUN_TIMEOUT_MS)
  const claimed = await meta.claimJob(
    job.id,
    new Date(now.getTime() + RUN_LEASE_MS).toISOString(),
    now.toISOString(),
  )
  if (!claimed) {
    await giveBack()
    return null
  }
  try {
    const held = await meta.transitionJobMachine(claimed.id, claimed.machine_rev, {
      phase: "starting",
      machine_json: JSON.stringify({
        turn: newId("mjt"),
        active_at: now.toISOString(),
        deadline_at: deadline.toISOString(),
      } satisfies MachineState),
    })
    if (held) {
      wakeClaimed(deps, held)
      return held
    }
  } catch {
    // Another job already holds this agent's machine (the unique index).
  }
  await meta.updateJob(
    claimed.id,
    { status: "queued", started_at: null, lease_until: null },
    {
      status: "running",
      started_at: claimed.started_at,
    },
  )
  await giveBack()
  return null
}

/** Advance one job's turn a step. */
export async function advanceMachineJob(deps: MachineDeps, job: JobRecord): Promise<void> {
  const { meta } = deps
  const agent = await meta.getAgent(job.agent_id)
  const m = parse<MachineState>(job.machine_json)
  const move = (phase: NonNullable<JobRecord["machine_phase"]>, next: Partial<MachineState> = {}) =>
    meta.transitionJobMachine(job.id, job.machine_rev, {
      phase,
      machine_json: JSON.stringify({ ...m, ...next }),
    })
  const state = agent ? parse<SandboxState>(agent.sandbox_state_json) : null
  if (!agent || !state || !agent.sandbox_id || !m || state.holder !== job.id) {
    // Nothing to return the machine to: finish the bookkeeping and fail the work if it is open.
    await failIfOpen(deps, agent, job, "The machine for this job is gone.")
    await move("released")
    return
  }
  const runtime = await runtimeForAgent(deps, agent)
  if (state.api_url !== runtime.apiUrl || (state.provider ?? "ortam") !== runtime.provider)
    throw new Error("Sandbox belongs to a different runtime")
  const client = await clientFor(deps, agent)
  const sandbox = agent.sandbox_id
  const at = iso(deps)
  const expired = at >= m.deadline_at
  const open = job.status === "running"
  const environment = async () => ({
    DERIVE_TOKEN: await signWorkToken(
      "job",
      deps.secret,
      `${job.id}~${Date.parse(job.started_at ?? "")}`,
      agent.id,
      agent.org_id,
      Date.parse(m.deadline_at) + 5 * 60_000,
    ),
    DERIVE_SERVER: deps.server,
    DERIVE_JOB_ID: job.id,
    DERIVE_RUNNER_ISOLATED: "1",
  })

  if (job.machine_phase !== "stopping" && (expired || !open || !(await admitted(deps, agent)))) {
    await move("stopping")
    return
  }
  switch (job.machine_phase) {
    case "starting": {
      if (!m.resume_op) {
        const op = await client.lifecycle(
          sandbox,
          "resume",
          `derive-job-${m.turn}-resume`,
          state.identity,
          await environment(),
        )
        await move("starting", { resume_op: op.id, active_at: m.active_at ?? at })
        return
      }
      const op = await client.operation(m.resume_op, sandbox, "resume", state.identity)
      if (op.state === "succeeded") await move("ready")
      if (op.state === "failed") await move("stopping")
      return
    }
    case "ready": {
      const observed = await client.sandbox(sandbox, state.identity)
      if (
        observed.state !== "ready" ||
        observed.auto_stop_after_seconds <= 0 ||
        observed.auto_stop_after_seconds > 1200
      ) {
        await move("stopping")
        return
      }
      const launching = await move("launching")
      // Exactly the transition's winner submits. The start is keyed to this turn, so Ortam
      // answers a repeat with the same process; a lost response still leaves `launching` until
      // the deadline stops the machine.
      if (!launching || !job.started_at) return
      // Bound to this claim, so a later claim of the same job (a retry) does not revive it.
      const process = await client.launch(
        sandbox,
        {
          argv: [
            "sh",
            "-c",
            `${INSTALL_RUNTIME_RUNNER}\nexec node "$@"`,
            "derive-runner",
            deps.config.runnerPath,
            "runner",
            "run",
            "--cwd",
            WORKDIR,
          ],
          cwd: "/home/ortam",
          env: await environment(),
          timeout_seconds: Math.max(
            1,
            Math.ceil((Date.parse(m.deadline_at) - Date.parse(at)) / 1000),
          ),
        },
        `derive-job-${m.turn}-launch`,
        state.identity,
      )
      await meta.transitionJobMachine(job.id, launching.machine_rev, {
        phase: "running",
        machine_json: JSON.stringify({ ...m, process_id: process.id }),
      })
      return
    }
    case "running": {
      if (!m.process_id) {
        await move("stopping")
        return
      }
      const process = await client.process(sandbox, m.process_id, state.identity)
      if (!["starting", "running"].includes(process.status)) await move("stopping")
      return
    }
    case "stopping": {
      const observed = await client.sandbox(sandbox, state.identity)
      // A sandbox Ortam marked `failed` (an activation that failed on resume) refuses stop with
      // a 409 forever. Give the job back to the queue and the sandbox to deletion; the agent's
      // next job builds a fresh one.
      if (observed.state === "failed") {
        await failIfOpen(deps, agent, job, "The machine for this job failed to start.")
        const released = await move("released")
        if (released)
          await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
            phase: "deleting",
            state_json: JSON.stringify({
              ...state,
              holder: null,
              failures: (state.failures ?? 0) + 1,
            }),
          })
        return
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
      const fresh = await meta.getJob(job.id)
      if (fresh && m.active_at) {
        const stopped = iso(deps)
        const usage = await client
          .usage?.(sandbox, m.active_at, stopped, state.identity)
          .catch(() => null)
        const result = jobResult(fresh)
        if (!result.compute?.some((c) => c.turn === m.turn)) {
          const updated = await meta.updateJob(
            job.id,
            {
              result_json: JSON.stringify({
                ...result,
                compute: [
                  ...(result.compute ?? []),
                  {
                    turn: m.turn,
                    provider: state.provider ?? "ortam",
                    ...(state.connection_id ? { connection_id: state.connection_id } : {}),
                    sandbox_id: sandbox,
                    started_at: m.active_at,
                    stopped_at: stopped,
                    billable_seconds: usage?.billable_seconds ?? null,
                    cost_micro_usd: usage?.cost_micro_usd ?? null,
                  },
                ],
              }),
            },
            { status: fresh.status, started_at: fresh.started_at },
          )
          if (updated) wakeSettled(deps, updated)
        }
      }
      const released = await move("released")
      if (released)
        await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
          phase: "ready",
          state_json: JSON.stringify({ ...state, holder: null }),
        })
      return
    }
    default:
      return
  }
}

async function failIfOpen(
  deps: MachineDeps,
  agent: AgentRecord | null,
  job: JobRecord,
  why: string,
) {
  const fresh = await deps.meta.getJob(job.id)
  if (!agent || fresh?.status !== "running") return
  await reportJob(deps, agent, job.id, {
    started_at: fresh.started_at,
    status: "failed",
    body_md: why,
    retryable: true,
  }).catch(() => null)
}

// ---- The pass --------------------------------------------------------------------------------

/** One pass: advance every machine job, then every sandbox mid-lifecycle, then lend ready
 *  sandboxes to queued work within the limits. Each item is isolated; a failure defers it. */
export async function machinePass(
  deps: MachineDeps,
): Promise<{ advanced: number; dispatched: number }> {
  const { meta } = deps
  const out = { advanced: 0, dispatched: 0 }
  const guard = async (what: string, id: string, work: () => Promise<unknown>) => {
    try {
      await work()
      out.advanced++
    } catch (error) {
      // Ortam bodies and runner output can carry credentials: ids and a category only.
      log.warn("machine step deferred", { what, id, reason: runtimeFailureReason(error) })
    }
  }
  const holding = await meta.listMachineJobs(100)
  for (const job of holding) await guard("job", job.id, () => advanceMachineJob(deps, job))
  for (const agent of await meta.listAgentsInSandboxPhase(
    ["creating", "provisioning", "stopping", "deleting"],
    100,
  ))
    await guard("sandbox", agent.id, () => advanceSandbox(deps, agent))

  // A sandbox left `busy` by a job that has already let go (a crash between the job's release
  // and the agent's) goes back to ready.
  for (const agent of await meta.listAgentsInSandboxPhase(["busy"], 100))
    await guard("repair", agent.id, async () => {
      const holder = parse<SandboxState>(agent.sandbox_state_json)?.holder
      const job = holder ? await meta.getJob(holder) : null
      if (job && job.machine_phase !== null && job.machine_phase !== "released") return
      await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
        phase: "ready",
        state_json: JSON.stringify({
          ...parse<SandboxState>(agent.sandbox_state_json),
          holder: null,
        }),
      })
    })

  // A sandbox whose agent no longer runs on Derive is deleted; its files are gone with it.
  for (const agent of await meta.listAgentsInSandboxPhase(["ready"], 100))
    if (!(await admitted(deps, agent)))
      await guard("retire", agent.id, () =>
        meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
          phase: "deleting",
        }),
      )

  // Sandboxes coming up count against the same ceilings as jobs holding one.
  const starting = await meta.listAgentsInSandboxPhase(["creating", "provisioning"], 100)
  const perOrg = new Map<string, number>()
  const count = (org: string) => perOrg.set(org, (perOrg.get(org) ?? 0) + 1)
  for (const j of await meta.listMachineJobs(100)) count(j.org_id)
  for (const a of starting) count(a.org_id)
  let room = GLOBAL_LIMIT - [...perOrg.values()].reduce((n, x) => n + x, 0)
  const tried = new Set<string>()
  for (const job of await meta.listQueuedDeriveJobs(50)) {
    if (room <= 0) break
    if ((perOrg.get(job.org_id) ?? 0) >= ORG_LIMIT) continue
    if (tried.has(job.agent_id)) continue
    tried.add(job.agent_id)
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
      if (!(await admitted(deps, agent))) return
      // A reconnect keeps the selected account and queued work. Do not allocate compute
      // or silently bill another account while its credential is being replaced.
      const account = agent.account_id ? await meta.getAccount(agent.account_id) : null
      if (account?.status === "connecting" || account?.status === "needs_attention") {
        const last = (await meta.listJobMessages(job.id)).at(-1)
        if (!last?.meta_json || JSON.parse(last.meta_json).held !== "account")
          await meta.addJobMessage({
            id: newId("jm"),
            job_id: job.id,
            author_kind: "agent",
            author_id: agent.id,
            body_md:
              "This task waits for its model account. Finish connecting or cancel the reconnect in Settings → Model accounts.",
            meta_json: JSON.stringify({ progress: true, held: "account", server: true }),
          })
        return
      }
      // Past its payer's monthly budget: no sandbox comes up, and the job says why it waits.
      if (await jobOverBudget(meta, job)) {
        await noteHeldForBudget(meta, job)
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
          await advanceSandbox(deps, starting).catch(async (error: unknown) => {
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
      const held = await borrow(deps, agent, job)
      if (!held) return
      room--
      out.dispatched++
      count(job.org_id)
      await advanceMachineJob(deps, held)
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
    await reportJob(deps, agent, job.id, {
      started_at: claimed.started_at,
      status: "failed",
      body_md: why,
    }).catch(() => null)
  }
}

/** Delete an agent's sandbox now, for an agent that is itself being deleted (its row, and with
 *  it the sandbox's identity, is about to go). Best effort; the sandbox's own auto-stop bounds
 *  compute if this fails. */
export async function retireSandbox(deps: MachineDeps | null, agent: AgentRecord): Promise<void> {
  const state = parse<SandboxState>(agent.sandbox_state_json)
  if (!state?.identity || !deps) return
  const runtime = await runtimeForAgent(deps, agent)
  if (agent.sandbox_phase === null || agent.sandbox_phase === "failed") return
  try {
    if (state.api_url !== runtime.apiUrl || (state.provider ?? "ortam") !== runtime.provider)
      throw new Error("Sandbox belongs to a different runtime")
    const client = await clientFor(deps, agent)
    // A create whose answer never arrived still made a sandbox; its key finds it.
    const id =
      agent.sandbox_id ??
      (
        await client.create(
          sandboxRequest(agent, state),
          `derive-agent-${agent.id}-${state.generation}-create`,
          state.identity,
        )
      ).sandbox.id
    if (await client.isSandboxDeleted(id, state.identity)) return
    await client.deleteSandbox(
      id,
      `derive-agent-${agent.id}-${state.generation}-delete`,
      state.identity,
    )
  } catch (error) {
    log.warn("sandbox retire failed", { agent: agent.id, reason: runtimeFailureReason(error) })
  }
}

/** For the tick's callers: the pass, or nothing when this deploy has no Derive machines. */
export const machineDepsFrom = (
  meta: MetaStore,
  opts: {
    secret?: string
    server?: string
    config?: AppDeps["runtime"]
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
