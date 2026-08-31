import {
  type AutomationRecord,
  type GithubWorkflowAutomationAction,
  type MetaStore,
  newId,
} from "@derive/core"
import { parseTrigger } from "./automation"
import { executeHttpTool, parseConnectionIds, spendableConnections } from "./broker"
import { githubSourcePolicy } from "./github-source-policy"

const isoNow = () => new Date().toISOString()

export class DirectAutomationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502 = 400,
  ) {
    super(message)
    this.name = "DirectAutomationError"
  }
}

export const githubWorkflowAction = (
  automation: Pick<AutomationRecord, "trigger">,
): GithubWorkflowAutomationAction | null => {
  const action = parseTrigger(automation.trigger).action
  return action?.kind === "github_workflow" ? action : null
}

const workflowPath = (action: GithubWorkflowAutomationAction): string =>
  `/repos/${action.owner}/${action.repo}/actions/workflows/${action.workflow}/dispatches`

const workflowBody = (action: GithubWorkflowAutomationAction): Record<string, unknown> => ({
  ref: action.ref,
  ...(action.inputs && Object.keys(action.inputs).length ? { inputs: action.inputs } : {}),
})

export interface GithubActionReceipt {
  run_id: string
  url: string
}

/** GitHub's modern dispatch endpoint returns a run id. Normalize it at the trust boundary and
 * construct the browser URL ourselves instead of persisting an arbitrary URL from upstream. */
export const githubActionReceipt = (
  action: GithubWorkflowAutomationAction,
  body: unknown,
): GithubActionReceipt | null => {
  const value = (body ?? {}) as { workflow_run_id?: unknown }
  const raw = value.workflow_run_id
  const runId =
    typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
      ? String(raw)
      : typeof raw === "string" && /^[1-9][0-9]{0,19}$/.test(raw)
        ? raw
        : null
  if (!runId) return null
  return {
    run_id: runId,
    url: `https://github.com/${action.owner}/${action.repo}/actions/runs/${runId}`,
  }
}

export const validateGithubWorkflowAutomation = async (
  meta: MetaStore,
  orgId: string,
  connectionIds: string[],
  action: GithubWorkflowAutomationAction,
) => {
  if (connectionIds.length !== 1)
    throw new DirectAutomationError("GitHub Actions needs one GitHub connection")
  const [connection] = await spendableConnections(meta, orgId, connectionIds)
  if (
    !connection ||
    connection.id !== connectionIds[0] ||
    connection.kind !== "github_app" ||
    connection.toolkit !== "github"
  )
    throw new DirectAutomationError("select an active GitHub App connection for this workspace")
  const base = connection.base_url
  if (!base) throw new DirectAutomationError("the GitHub connection is not ready")
  githubSourcePolicy(
    "github.post",
    new URL(`.${workflowPath(action)}`, `${base}/`),
    workflowBody(action),
  )
  return connection
}

export const runDirectAutomation = async (input: {
  meta: MetaStore
  automation: AutomationRecord
  encryptionKey?: string
  reason: string
  initiatedBy: string | null
}) => {
  const { meta, automation, encryptionKey, reason, initiatedBy } = input
  if (!encryptionKey) throw new DirectAutomationError("GitHub Actions is not configured", 502)
  const action = githubWorkflowAction(automation)
  if (!action) throw new DirectAutomationError("automation has no direct action")
  const connection = await validateGithubWorkflowAutomation(
    meta,
    automation.org_id,
    parseConnectionIds(automation.connection_ids),
    action,
  )
  const startedAt = isoNow()
  const run = await meta.createRun({
    id: newId("run"),
    org_id: automation.org_id,
    automation_id: automation.id,
    agent_id: automation.agent_id,
    reason,
    initiated_by: initiatedBy,
    status: "running",
    scheduled_for: startedAt,
    started_at: startedAt,
    meta: JSON.stringify({ action }),
  })
  try {
    const result = await executeHttpTool(
      meta,
      connection,
      "github.post",
      { path: workflowPath(action), body: workflowBody(action) },
      encryptionKey,
    )
    if (result.status < 200 || result.status >= 300)
      throw new DirectAutomationError(
        `GitHub refused the workflow dispatch (${result.status})`,
        502,
      )
    const finishedAt = isoNow()
    const receipt = githubActionReceipt(action, result.body)
    const finished = await meta.finishRun(run.id, automation.agent_id, {
      status: "succeeded",
      finishedAt,
      meta: JSON.stringify({
        action,
        outcome: "dispatched",
        response: result.body,
        ...(receipt ? { github_action: receipt } : {}),
      }),
    })
    return finished ?? run
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub workflow dispatch failed"
    await meta.finishRun(run.id, automation.agent_id, {
      status: "failed",
      finishedAt: isoNow(),
      meta: JSON.stringify({ action, outcome: "failed", last_error: message }),
    })
    throw error instanceof DirectAutomationError ? error : new DirectAutomationError(message, 502)
  }
}
