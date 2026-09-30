import type { AgentRecord, JobRecord, MetaStore } from "@derive/core"
import type { AppDeps } from "../context"
import { log } from "../log"
import { sha256 } from "./crypto"
import { type JobDeps, reportJob } from "./jobs"
import { OrtamClient } from "./ortam-client"
import { signWorkToken } from "./run-token"
import { runtimeFailureReason } from "./runtime-diagnostics"
import { INSTALL_RUNTIME_RUNNER } from "./runtime-setup"

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

/** A job's whole turn on the machine, boot to stop. */
export const MACHINE_JOB_MS = 15 * 60_000
/** Global and per-workspace ceilings on jobs holding a sandbox at once. */
const GLOBAL_LIMIT = 10
const ORG_LIMIT = 3
const WORKDIR = "/home/ortam/work"

interface Identity {
  organization_id: string
  user_id: string
}
interface SandboxState {
  api_url: string
  identity: Identity
  create_op?: string
  stop_op?: string
  delete_op?: string
  holder?: string | null
}
interface MachineState {
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

/** Which workspaces may run Derive machines: the managed Ortam allowlist. */
export const machineWorkspaces = (config: AppDeps["runtime"] | undefined): ReadonlySet<string> =>
  config?.managed?.apiKey ? config.managed.workspaceIds : new Set()

/** One integration subject per agent, so each agent's sandbox belongs to its own Ortam user. */
const clientFor = (deps: MachineDeps, agent: AgentRecord) => {
  if (!deps.config.managed?.apiKey) throw new Error("Derive machines are not configured")
  return new OrtamClient(
    deps.config.apiUrl,
    deps.config.managed.apiKey,
    deps.fetcher,
    sha256(JSON.stringify([agent.org_id, "agent", agent.id])),
  )
}

const iso = (deps: MachineDeps) => (deps.now?.() ?? new Date()).toISOString()

/** May this agent hold a sandbox right now? */
const admitted = async (deps: MachineDeps, agent: AgentRecord) =>
  agent.machine === "derive" &&
  !agent.paused_at &&
  machineWorkspaces(deps.config).has(agent.org_id) &&
  (await deps.meta.getOrgSettings(agent.org_id).catch(() => null))?.agentWrites !== false

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

  if (agent.sandbox_phase === null) {
    if (!allowed) return agent
    const client = clientFor(deps, agent)
    const auth = await client.authenticate()
    return meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
      phase: "creating",
      state_json: JSON.stringify({
        api_url: deps.config.apiUrl,
        identity: { organization_id: auth.organization_id, user_id: auth.user_id },
      } satisfies SandboxState),
    })
  }
  if (!state) return move("failed")
  if (state.api_url !== deps.config.apiUrl)
    throw new Error("Sandbox belongs to a different Ortam API")
  const client = clientFor(deps, agent)
  const id = agent.sandbox_id

  switch (agent.sandbox_phase) {
    case "creating": {
      if (!allowed) return move("failed")
      // The same immutable request and key, so a lost response resolves to the same sandbox.
      const result = await client.create(
        {
          name: `derive-${agent.id.replaceAll("_", "-")}`,
          size: "small",
          auto_stop_after_seconds: 1200,
          setup_script: INSTALL_RUNTIME_RUNNER,
        },
        `derive-agent-${agent.id}-create`,
        state.identity,
      )
      return move("provisioning", { create_op: result.operation.id }, result.sandbox.id)
    }
    case "provisioning": {
      if (!id || !state.create_op) return move("failed")
      const op = await client.operation(state.create_op, id, "create", state.identity)
      if (op.state === "succeeded") return move(allowed ? "stopping" : "deleting")
      if (op.state === "failed") return move("deleting")
      return agent
    }
    case "stopping": {
      if (!id) return move("failed")
      const sandbox = await client.sandbox(id, state.identity)
      if (sandbox.state === "stopped") return move("ready", { stop_op: undefined })
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
      if (op.state === "failed") return move("deleting", { stop_op: undefined })
      return agent
    }
    case "deleting": {
      if (!id) return move("failed")
      if (!state.delete_op) {
        if (await client.isSandboxDeleted(id, state.identity)) return move("failed")
        const op = await client.deleteSandbox(id, `derive-agent-${agent.id}-delete`, state.identity)
        return move("deleting", { delete_op: op.id })
      }
      const op = await client.operation(state.delete_op, id, "delete", state.identity)
      if (
        op.state === "succeeded" ||
        (op.state === "failed" && (await client.isSandboxDeleted(id, state.identity)))
      )
        return move("failed")
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
  const deadline = new Date(now.getTime() + MACHINE_JOB_MS)
  // The lease outlasts the deadline, so reclaim never races a machine that is still stopping.
  const claimed = await meta.claimJob(
    job.id,
    new Date(deadline.getTime() + 10 * 60_000).toISOString(),
    now.toISOString(),
  )
  if (!claimed) {
    await giveBack()
    return null
  }
  try {
    const held = await meta.transitionJobMachine(claimed.id, claimed.machine_rev, {
      phase: "starting",
      machine_json: JSON.stringify({ deadline_at: deadline.toISOString() } satisfies MachineState),
    })
    if (held) return held
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
  const client = clientFor(deps, agent)
  const sandbox = agent.sandbox_id
  const at = iso(deps)
  const expired = at >= m.deadline_at
  const open = job.status === "running"

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
          `derive-job-${job.id}-${job.attempt}-resume`,
          state.identity,
        )
        await move("starting", { resume_op: op.id })
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
      // Exactly the transition's winner submits: a process request is not idempotent, and a
      // lost response leaves `launching` until the deadline stops the machine.
      if (!launching || !job.started_at) return
      const token = await signWorkToken(
        "job",
        deps.secret,
        job.id,
        agent.id,
        agent.org_id,
        Date.parse(m.deadline_at) + 5 * 60_000,
      )
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
          env: {
            DERIVE_TOKEN: token,
            DERIVE_SERVER: deps.server,
            DERIVE_JOB_ID: job.id,
            DERIVE_RUNNER_ISOLATED: "1",
          },
          timeout_seconds: Math.max(
            1,
            Math.ceil((Date.parse(m.deadline_at) - Date.parse(at)) / 1000),
          ),
        },
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
      if (observed.state !== "stopped") {
        if (!m.stop_op) {
          const op = await client.lifecycle(
            sandbox,
            "stop",
            `derive-job-${job.id}-${job.attempt}-stop`,
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

  const orgs = machineWorkspaces(deps.config)
  if (orgs.size === 0) return out
  const active = (await meta.listMachineJobs(100)).length
  let room = GLOBAL_LIMIT - active
  const perOrg = new Map<string, number>()
  for (const j of holding) perOrg.set(j.org_id, (perOrg.get(j.org_id) ?? 0) + 1)
  for (const job of await meta.listQueuedDeriveJobs(50, [...orgs])) {
    if (room <= 0) break
    if ((perOrg.get(job.org_id) ?? 0) >= ORG_LIMIT) continue
    await guard("dispatch", job.id, async () => {
      let agent = await meta.getAgent(job.agent_id)
      if (!agent || !(await admitted(deps, agent))) return
      // First job for this agent: bring its sandbox up; the job waits for it.
      if (agent.sandbox_phase === null || agent.sandbox_phase === "failed") {
        if (agent.sandbox_phase === "failed")
          agent = await meta.transitionAgentSandbox(agent.id, agent.org_id, agent.sandbox_rev, {
            phase: null,
            state_json: null,
            sandbox_id: null,
          })
        if (agent) await advanceSandbox(deps, agent)
        return
      }
      const held = await borrow(deps, agent, job)
      if (!held) return
      room--
      out.dispatched++
      perOrg.set(job.org_id, (perOrg.get(job.org_id) ?? 0) + 1)
      await advanceMachineJob(deps, held)
    })
  }
  return out
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
  },
): MachineDeps | null =>
  opts.secret && opts.server && opts.config?.managed?.apiKey
    ? {
        meta,
        secret: opts.secret,
        server: opts.server,
        config: opts.config,
        fetcher: opts.fetcher,
        bus: opts.bus,
      }
    : null
