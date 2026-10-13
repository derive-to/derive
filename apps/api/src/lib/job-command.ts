import {
  type AgentRecord,
  artifactUserCan,
  type JobCommand,
  type JobCommandIntent,
  type JobExecution,
  newId,
  WORKSPACE_ACCOUNT_OWNER,
} from "@derive/core"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { parseConnectionIds, spendableConnections } from "./broker"
import { jobsOverBudget, OVER_BUDGET } from "./budget"
import { readEnvironmentBindings } from "./context-environment"
import { sha256 } from "./crypto"
import { jobPayer, resolveJobCredential } from "./job-accounts"
import { canAskAgent, canSteerJob, type JobDeps } from "./job-policy"
import { cloudEnabled, workspaceRuntime } from "./runtime-connection"

export class JobCommandError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode = 409,
  ) {
    super(message)
    this.name = "JobCommandError"
  }
}

/** All cloud admission paths use the same policy. Postgres commits the command atomically. */
export const commandJob = async (
  deps: JobDeps,
  agent: AgentRecord,
  actor: string | null,
  input: JobCommandIntent & { source: string; key: string },
) => {
  const store = deps.meta.jobExecution
  if (!store) throw new JobCommandError("Cloud tasks need Postgres storage.", 503)
  const requestHash = sha256(
    JSON.stringify({
      intent: input.intent,
      question: input.intent === "answer" ? input.question_id : null,
      actor,
      agent: agent.id,
      body: "body" in input && input.intent !== "retry" ? input.body : null,
      job: "job_id" in input ? input.job_id : null,
      subject: "job" in input ? input.job.subject_json : null,
      parent: "job" in input ? input.job.parent_id : null,
      node: "job" in input ? input.job.node_id : null,
      trigger: "job" in input ? input.job.trigger_id : null,
      window: "job" in input ? input.job.scheduled_for : null,
      task: "job" in input ? (input.job.meta_json ?? null) : null,
      interrupt: input.intent === "follow_up" ? !!input.interrupt : null,
    }),
  )
  const current = "job_id" in input ? await deps.meta.getJob(input.job_id) : null
  const allowed =
    actor &&
    (current
      ? await canSteerJob(deps.meta, agent, current, actor)
      : await canAskAgent(deps.meta, agent, actor))
  // Schedules are owned configuration, not arbitrary client-supplied source names.
  if (!allowed && !(actor === null && input.intent === "cancel" && input.source === "system"))
    throw new JobCommandError("You cannot start or change this task.", 403)
  const prior = await store.receipt(agent.org_id, input.source, input.key)
  let selection: JobExecution | null = null
  let refusal: { error: string; status: number } | undefined
  if (!prior && input.intent !== "cancel") {
    const reject = (error: string, status = 409) => {
      refusal = { error, status }
    }
    if (
      !deps.cloud?.secret ||
      !deps.cloud.config ||
      !(await cloudEnabled(deps.meta, deps.cloud.config, agent.org_id))
    )
      reject("Connect a sandbox in Settings → Sources before starting.")
    const account = await resolveJobCredential(
      deps.meta,
      deps.cloud?.secret,
      agent,
      { asked_by: actor },
      agent.provider,
    )
    if (!account.credential)
      reject("Your model account needs attention. Connect it in Settings before starting.")
    else {
      const row = await deps.meta.getAccount(account.account_id)
      if (!row || (actor && row.user_id !== actor && row.user_id !== WORKSPACE_ACCOUNT_OWNER))
        reject("This model account is private. Use your account or a shared workspace account.")
    }
    const skill = agent.instructions_artifact_id
      ? await deps.meta.getArtifactById(agent.instructions_artifact_id)
      : null
    const runtime = await workspaceRuntime(deps.meta, deps.cloud?.config, agent.org_id)
    if (
      agent.instructions_artifact_id &&
      (!skill || skill.org_id !== agent.org_id || skill.removed_at)
    )
      reject("The agent’s skill is unavailable.")
    selection = {
      version: 1,
      agent_name: agent.name,
      provider: agent.provider,
      model: agent.model ?? (agent.provider === "codex" ? "gpt-6-luna" : "sonnet"),
      effort: agent.effort,
      account_id: account.credential ? account.account_id : null,
      connection_ids: parseConnectionIds(agent.connection_ids_json),
      repositories_json: agent.repositories_json ?? "[]",
      environment_json: agent.environment_json ?? "{}",
      skill: skill ? { artifact_id: skill.id, version: skill.current_version } : null,
      sandbox: {
        provider: runtime.provider,
        connection_id: runtime.connection?.id ?? null,
        account_id: runtime.connection?.broker_ref ?? null,
        spec_json: agent.sandbox_json,
      },
    }
    const problem = await turnProblem(deps, agent, actor, selection)
    if (problem) reject(problem)
    const payerAgent = turnAgent(agent, selection)
    const payer = await jobPayer(deps.meta, payerAgent, actor)
    if (input.intent === "start") input.job.payer_id = payer
    if (await jobsOverBudget(deps.meta, agent.org_id, payer)) {
      if (!input.source.startsWith("schedule:")) reject(OVER_BUDGET, 402)
    }
    if (current) {
      const turns = await store.turns(current.id, current.org_id)
      const previous =
        current.status === "running" || current.status === "queued"
          ? turns.at(-1)
          : turns
              .filter(
                (t) =>
                  t.status !== "queued" &&
                  t.status !== "running" &&
                  !(t.status === "cancelled" && t.started_at === null),
              )
              .at(-1)
      if (previous) {
        if (previous.actor_id !== actor)
          reject(
            "This conversation belongs to another person. Start a fresh task to use your accounts and files.",
          )
        if (input.intent === "retry") input.body = previous.body_md
        const before = JSON.parse(previous.execution_json) as JobExecution
        if (
          before.provider !== selection.provider ||
          before.account_id !== selection.account_id ||
          before.sandbox?.provider !== selection.sandbox.provider ||
          before.sandbox?.connection_id !== selection.sandbox.connection_id ||
          before.sandbox?.account_id !== selection.sandbox.account_id
        )
          reject(
            "This conversation uses another harness or account. Start a fresh task with the new settings.",
          )
        if (
          !["queued", "running"].includes(previous.status) &&
          !turns.some((t) => t.session_id && t.has_checkpoint)
        )
          reject(
            "The conversation checkpoint is unavailable. Start a fresh task with the context you want to keep.",
          )
      }
      if (turns.length >= 200)
        reject("This task has 200 turns. Start a fresh task to keep working.")
    }
  }
  const command = {
    ...input,
    org_id: agent.org_id,
    actor_id: actor,
    request_hash: requestHash,
    execution: selection,
    ...(refusal ? { refusal } : {}),
  } as JobCommand
  const out = await store.command(command)
  if (out.receipt.error)
    throw new JobCommandError(out.receipt.error, out.receipt.status_code as ContentfulStatusCode)
  if (!out.job)
    throw new JobCommandError(
      "This task was deleted. The original request will not run again.",
      410,
    )
  return {
    job: out.job,
    created: out.applied,
    turn_id: out.receipt.turn_id,
  }
}

/** Apply immutable turn configuration while rechecking live credentials and membership. */
export const turnAgent = (agent: AgentRecord, execution: JobExecution): AgentRecord => ({
  ...agent,
  provider: execution.provider,
  model: execution.model,
  // Turns admitted before these were frozen keep the agent's current values.
  effort: execution.effort === undefined ? agent.effort : execution.effort,
  sandbox_json:
    execution.sandbox?.spec_json === undefined ? agent.sandbox_json : execution.sandbox.spec_json,
  account_id: execution.account_id,
  connection_ids_json: JSON.stringify(execution.connection_ids),
  repositories_json: execution.repositories_json,
  environment_json: execution.environment_json,
  instructions_artifact_id: execution.skill?.artifact_id ?? null,
})

export const commandKey = (key?: string | null) => key || newId("cmd")

/** Recheck identities before spending credentials or allocating compute. */
export const turnProblem = async (
  deps: JobDeps,
  agent: AgentRecord,
  actor: string | null,
  choice: JobExecution,
): Promise<string | null> => {
  if (!actor || !(await canAskAgent(deps.meta, agent, actor)))
    return "The person who started this turn no longer has access."
  const runtime = await workspaceRuntime(deps.meta, deps.cloud?.config, agent.org_id)
  if (
    !choice.sandbox ||
    choice.sandbox.provider !== runtime.provider ||
    choice.sandbox.connection_id !== (runtime.connection?.id ?? null) ||
    choice.sandbox.account_id !== (runtime.connection?.broker_ref ?? null)
  )
    return "The sandbox account changed. Start a fresh task with the new connection."
  const credential = await resolveJobCredential(
    deps.meta,
    deps.cloud?.secret,
    turnAgent(agent, choice),
    { asked_by: actor },
    choice.provider,
  )
  if (!credential.credential)
    return "This task waits for its model account. Reconnect it in Settings → Model accounts."
  const account = await deps.meta.getAccount(credential.account_id)
  if (!account || (account.user_id !== actor && account.user_id !== WORKSPACE_ACCOUNT_OWNER))
    return "This model account is private. Use your account or a shared workspace account."
  if (choice.skill) {
    const skill = await deps.meta.getArtifactById(choice.skill.artifact_id)
    if (
      !skill ||
      skill.org_id !== agent.org_id ||
      skill.removed_at ||
      !(await artifactUserCan(deps.meta, actor, "read", skill)) ||
      !(await deps.meta.getVersion(skill.id, choice.skill.version))
    )
      return "The skill for this turn is unavailable. Check its access before starting a fresh task."
  }
  const envIds = Object.values(readEnvironmentBindings(choice.environment_json))
  const ids = [...new Set([...choice.connection_ids, ...envIds])]
  const available = await spendableConnections(deps.meta, agent.org_id, ids)
  if (
    ids.some(
      (id) =>
        !available.some((cn) => cn.id === id && (cn.scope === "workspace" || cn.user_id === actor)),
    )
  )
    return "A connection for this task is unavailable. Check the agent’s connections in Settings."
  if (
    envIds.some(
      (id) => !available.some((cn) => cn.id === id && cn.kind === "secret" && cn.secret_enc),
    )
  )
    return "A secret for this task is unavailable. Check the agent’s environment in Settings."
  return null
}
