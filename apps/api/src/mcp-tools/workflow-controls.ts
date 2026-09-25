import { roleAllows } from "@derive/core"
import type { ToolContext } from "../mcp-tool-context"
import { json } from "../mcp-util"

// Fixed operations over the same HTTP handlers used by the UI. No generic URL proxy,
// alternate workflow state or duplicated admission/credential policy.
const operations = {
  workflow_create: ["POST", "/v1/workflow-runtimes", ["name", "model_connection_id", "request_id"]],
  workflow_save: ["PUT", "/v1/workflow-runtimes/:id", ["instruction", "provider", "revision"]],
  workflow_test: ["POST", "/v1/workflow-runtimes/:id/tests", ["request_id", "revision"]],
  workflow_schedule: [
    "PUT",
    "/v1/contexts/:id/runtime/schedule",
    ["instruction", "provider", "cron", "timezone", "enabled", "revision"],
  ],
  workflow_account: [
    "PUT",
    "/v1/contexts/:id/runtime/model-connection",
    ["connection_id", "revision"],
  ],
  workflow_environment: ["PUT", "/v1/contexts/:id/environment", ["bindings"]],
  workflow_connections: ["POST", "/v1/contexts/:id/connections", ["connection_ids"]],
  workflow_cancel_preparation: ["POST", "/v1/contexts/:id/runtime/setup/cancel", []],
  workflow_disable: ["POST", "/v1/contexts/:id/runtime/disable", []],
} as const
export const WORKFLOW_ACTIONS = Object.keys(operations)
const views = {
  workflows: "/v1/workflow-runtimes",
  configuration: "/v1/workflow-runtimes/:id",
  runs: "/v1/contexts/:id/runtime",
  account: "/v1/contexts/:id/runtime/model-connection",
  environment: "/v1/contexts/:id/environment",
  accounts: "/v1/runtime-model-connections",
  credentials: "/v1/credentials",
  connections: "/v1/connections",
} as const
export const WORKFLOW_VIEWS = Object.keys(views)

function pathFor(path: string, id?: string) {
  if (path.includes(":id")) {
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
    return path.replace(":id", id)
  }
  return id ? null : path
}

async function invoke(
  tc: ToolContext,
  path: string,
  method: "GET" | "POST" | "PUT",
  body: unknown,
  workspace?: string,
) {
  if (!tc.requestApi || !tc.ownerId || tc.registered || tc.workflowScope)
    return json({ error: "Sign in as a workspace member to manage cloud workflows" })
  const target = await tc.resolveWs(workspace)
  if ("error" in target) return json(target)
  // Management endpoints use a human grant. Reads here are management reads too;
  // the existing workflow_id-only readiness read remains available to read-only grants.
  if (tc.scopeForCap !== "owner" || !roleAllows(target.role, "publish"))
    return json({ error: "Reconnect with workflow management permission" })
  const response = await tc.requestApi(path, method, body, target.org)
  const result: unknown = await response.json()
  return json({ status: response.status, result })
}

export function readWorkflow(tc: ToolContext, view: string, id?: string, workspace?: string) {
  const template = Object.hasOwn(views, view) ? views[view as keyof typeof views] : null
  if (!template) return Promise.resolve(json({ error: `Use view: ${WORKFLOW_VIEWS.join(", ")}` }))
  const path = pathFor(template, id)
  if (!path)
    return Promise.resolve(
      json({
        error: template.includes(":id")
          ? "This view needs workflow_id (Context ID)"
          : "Omit workflow_id for this view",
      }),
    )
  return invoke(tc, path, "GET", undefined, workspace)
}

export function controlWorkflow(
  tc: ToolContext,
  action: string,
  id: string | undefined,
  body: Record<string, unknown> | undefined,
  workspace?: string,
) {
  const operation = Object.hasOwn(operations, action)
    ? operations[action as keyof typeof operations]
    : null
  if (!operation) return Promise.resolve(json({ error: "Unknown workflow action" }))
  const [method, template, fields] = operation
  const path = pathFor(template, id)
  if (!path)
    return Promise.resolve(
      json({
        error: template.includes(":id")
          ? "This action needs context_id (workflow ID)"
          : "Omit context_id when creating a workflow",
      }),
    )
  const unexpected = Object.keys(body ?? {}).filter(
    (key) => !(fields as readonly string[]).includes(key),
  )
  if (unexpected.length)
    return Promise.resolve(json({ error: `Unexpected workflow fields: ${unexpected.join(", ")}` }))
  return invoke(tc, path, method, body ?? {}, workspace)
}
