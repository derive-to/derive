import {
  type ContextRecord,
  type MetaStore,
  type RuntimeRunInput,
  roleAllows,
  type WorkflowReadiness,
} from "@derive/core"
import type { AppDeps } from "../context"
import { spendableConnections } from "./broker"
import { sha256 } from "./crypto"
import { managedModelClient } from "./runtime-controller"
import { runtimeInput } from "./runtime-input"
import { runtimeModelSelection } from "./runtime-model-grant"
import { SETUP_RUNNER_PATH } from "./runtime-setup"
import { workflowFilesAvailable } from "./workflow-files"

export const workflowRevision = (input: RuntimeRunInput | null, askPolicy: string) =>
  sha256(JSON.stringify([input, askPolicy]))

/** A revision of the task and its existing references, not another owner for those records. */
export async function workflowConfiguration(meta: MetaStore, context: ContextRecord) {
  const draft = await meta.getWorkflowDraft(context.id, context.org_id)
  const runtime = await meta.getContextRuntimeForContext(context.id, context.org_id)
  const schedule = runtime ? await meta.getRuntimeSchedule(runtime.id, context.org_id) : null
  const task = schedule ?? draft
  const input = await runtimeInput(meta, context, {
    instruction: task?.instruction ?? "",
    provider: task?.provider ?? "codex",
    model: null,
  })
  const revision = workflowRevision(input, context.ask_policy)
  return { draft, runtime, schedule, input, revision }
}

/** Shared by HTTP, MCP and admission. Readiness is a fresh explanation, never an execution grant. */
export async function workflowReadiness(
  meta: MetaStore,
  config: AppDeps["runtime"],
  context: ContextRecord,
  viewer: string,
  fetcher?: typeof fetch,
): Promise<WorkflowReadiness> {
  const { draft, runtime, schedule, input, revision } = await workflowConfiguration(meta, context)
  const member = await meta.getMembership(context.org_id, viewer)
  const canEdit =
    !!member &&
    roleAllows(member.role, "publish") &&
    (context.created_by === viewer || roleAllows(member.role, "manage"))
  const canRun =
    !!member &&
    roleAllows(member.role, "publish") &&
    (context.created_by === viewer ||
      context.ask_policy === "workspace" ||
      !!(await meta.getContextAsker(context.id, viewer)))
  const blockers: WorkflowReadiness["blockers"] = []
  const add = (
    code: string,
    message: string,
    action: WorkflowReadiness["blockers"][number]["action"] = null,
  ) =>
    blockers.push({
      code,
      message:
        !canEdit && action
          ? `${message} Ask the workflow owner to update its configuration.`
          : message,
      action:
        canEdit && (action !== "account" || config?.managed?.workspaceIds.has(context.org_id))
          ? action
          : null,
    })
  const settings = await meta.getOrgSettings(context.org_id)
  if (!config?.managed?.workspaceIds.has(context.org_id))
    add("workspace_unavailable", "Cloud workflows are not available in this workspace.")
  if (!canRun)
    add("permission_required", "Ask the workflow owner for permission to run this workflow.")
  if (!settings.hostedAgentsEnabled || !settings.agentWrites)
    add(
      "workspace_consent_required",
      "A workspace administrator needs to enable hosted agents and agent writes.",
      member && roleAllows(member.role, "manage") ? "settings" : null,
    )
  if (!config || config.runnerPath !== SETUP_RUNNER_PATH)
    add("service_unavailable", "Cloud execution needs an administrator’s attention.")
  if (runtime?.connection_id)
    add("operator_workflow", "This workflow uses operator-managed execution.")
  if (runtime?.disabled_at) add("workflow_disabled", "This workflow has been disabled.")
  if (!(schedule ?? draft)?.instruction.trim())
    add(
      "instructions_required",
      "Add instructions describing what this workflow should do.",
      "edit",
    )
  const selected = await runtimeModelSelection(meta, context.id, context.org_id)
  if (!selected)
    add("account_required", "Select an available model account for this workflow.", "account")
  else if (selected.connection.provider !== (schedule ?? draft)?.provider && (draft || schedule))
    add("account_incompatible", "Choose an account matching the workflow’s runner.", "account")
  else if (
    selected.connection.api_url !== config?.apiUrl ||
    (runtime && selected.connection.ortam_org_id !== runtime.ortam_org_id)
  )
    add("account_incompatible", "The selected account cannot run this workflow.", "account")
  else if (config && canRun) {
    try {
      const connected = await managedModelClient(
        config,
        selected.connection,
        fetcher,
      ).hasModelConnection(selected.connection.provider, {
        organization_id: selected.connection.ortam_org_id,
        user_id: selected.connection.ortam_user_id,
      })
      if (!connected)
        add(
          "account_sign_in_required",
          "The account owner needs to sign in again.",
          selected.connection.created_by === viewer ? "account" : null,
        )
    } catch {
      add("account_check_failed", "Could not check the model account. Try again.", "retry")
    }
  }
  if (!input && selected)
    add("files_unavailable", "The workflow’s instruction file is unavailable.", "edit")
  if (input?.files && !(await workflowFilesAvailable(meta, context.org_id, input.files)))
    add(
      "input_files_unavailable",
      "The selected input files are no longer available. Review the attachment.",
      "files",
    )
  if (input) {
    const required = [
      ...new Set([
        ...input.connection_ids,
        ...(input.repositories?.grants.map((r) => r.connection_id) ?? []),
        ...Object.values(input.environment_bindings),
      ]),
    ]
    const active = await spendableConnections(meta, context.org_id, required)
    if (required.some((id) => !active.some((item) => item.id === id)))
      add(
        "access_unavailable",
        "A selected tool or credential is no longer available. Review workflow access.",
        "access",
      )
  }
  const setup = await meta.getRuntimeSetup(context.id, context.org_id)
  const pending = await meta.latestWorkflowTest(context.id, context.org_id, viewer)
  const preparing =
    pending?.status === "pending" || (!!setup && !["ready", "failed"].includes(setup.phase))
  if (setup?.phase === "failed" && !runtime)
    add(
      "preparation_failed",
      "Preparation did not finish. Test again to retry with the saved configuration.",
      "retry",
    )
  if (!runtime && !canEdit)
    add("owner_preparation_required", "The workflow owner must complete the first test run.")
  const fatal = blockers.filter((b) => b.code !== "preparation_failed")
  return {
    state: fatal.length
      ? fatal[0]?.code === "instructions_required"
        ? "draft"
        : fatal[0]?.code.startsWith("account_")
          ? "needs_account"
          : fatal[0]?.code === "access_unavailable"
            ? "needs_access"
            : "needs_attention"
      : preparing
        ? "preparing"
        : blockers.length
          ? "needs_attention"
          : "ready",
    revision,
    evaluated_at: new Date().toISOString(),
    blockers,
    can_edit: canEdit,
    can_test: canRun && !preparing && fatal.length === 0,
  }
}
