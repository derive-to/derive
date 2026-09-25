import {
  type ContextRuntimeRecord,
  type MetaStore,
  type RunRecord,
  type RuntimeRunInput,
  roleAllows,
} from "@derive/core"
import type { AppDeps } from "../context"
import { spendableConnections } from "./broker"
import { credentialRevision } from "./credentials"
import { runtimeModelSelection } from "./runtime-model-grant"
import { workflowFilesAvailable } from "./workflow-files"
import { workflowConfiguration, workflowRevision } from "./workflow-readiness"

/** Live execution authority shared by dispatch, runner claims and every tool call.
 * Result receipts and shutdown deliberately do not depend on this grant. */
export async function runtimeRunContext(
  meta: MetaStore,
  config: AppDeps["runtime"],
  run: RunRecord,
  runtime: ContextRuntimeRecord | null,
) {
  if (
    !runtime ||
    runtime.disabled_at ||
    runtime.id !== run.runtime_id ||
    runtime.org_id !== run.org_id ||
    runtime.agent_id !== run.agent_id ||
    !run.initiated_by
  )
    return null
  const input = JSON.parse(run.input_snapshot ?? "null") as RuntimeRunInput | null
  if (input?.credential_revisions) {
    const revisions = Object.entries(input.credential_revisions)
    const credentials = await spendableConnections(
      meta,
      run.org_id,
      revisions.map(([id]) => id),
    )
    if (
      revisions.some(([id, revision]) => {
        const credential = credentials.find((cn) => cn.id === id)
        return !credential || credentialRevision(credential) !== revision
      })
    )
      return null
  }
  // A new attachment affects future runs; this run retains its accepted pin.
  // Removing the grantor's source access still revokes delivery immediately.
  if (input?.files && !(await workflowFilesAvailable(meta, run.org_id, input.files))) return null
  const managed = runtime.connection_id === null
  if (
    managed
      ? !config?.managed?.workspaceIds.has(run.org_id)
      : !config?.pilotWorkspaceIds.has(run.org_id)
  )
    return null
  const settings = await meta.getOrgSettings(run.org_id)
  if (!settings.hostedAgentsEnabled || !settings.agentWrites) return null
  const context = await meta.getContext(runtime.context_id)
  const agent = await meta.getAgent(run.agent_id)
  const member = await meta.getMembership(run.org_id, run.initiated_by)
  if (
    !member ||
    context?.org_id !== run.org_id ||
    context.agent_id !== run.agent_id ||
    agent?.org_id !== run.org_id
  )
    return null
  if (input?.workflow_revision) {
    const current = (await workflowConfiguration(meta, context)).input
    if (!current) return null
    // Keep property order stable: files precedes the other snapshot fields.
    const { files: _selectedFiles, ...rest } = current
    const accepted = input.files ? { files: input.files, ...rest } : rest
    if (workflowRevision(accepted, context.ask_policy) !== input.workflow_revision) return null
  }
  if (runtime.connection_id === null) {
    if (!roleAllows(member.role, "publish")) return null
    const binding = await meta.getRuntimeModelBinding(context.id, run.org_id)
    if (binding || input?.model_connection) {
      const selected = await runtimeModelSelection(meta, context.id, run.org_id)
      if (
        !selected ||
        selected.binding.revision !== input?.model_connection?.revision ||
        selected.connection.id !== input.model_connection.id ||
        selected.connection.provider !== input.provider
      )
        return null
    }
    if (
      context.created_by !== run.initiated_by &&
      context.ask_policy !== "workspace" &&
      !(await meta.getContextAsker(context.id, run.initiated_by))
    )
      return null
  } else {
    if (!(await meta.isInstanceOperator(run.initiated_by))) return null
    const credentials = await spendableConnections(meta, run.org_id, [runtime.connection_id])
    if (!credentials.some((c) => c.kind === "secret" && !!c.secret_enc)) return null
  }
  return context
}
