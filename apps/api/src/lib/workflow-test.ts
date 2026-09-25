import { type ContextRecord, type MetaStore, newId, type RuntimeRunInput } from "@derive/core"
import type { AppDeps } from "../context"
import { log } from "../log"
import { runtimeFailureReason } from "./runtime-diagnostics"

import { runtimeModelSelection } from "./runtime-model-grant"
import { runtimeSetupRequest, SETUP_TIMEOUT_MS } from "./runtime-setup"
import { workflowConfiguration, workflowReadiness } from "./workflow-readiness"

type WorkflowTestDeps = {
  meta: MetaStore
  config: NonNullable<AppDeps["runtime"]>
  fetcher?: typeof fetch
  pokeRuntime?: () => void
}

/** Reuse the setup saga and its permanent admission slot. No second provisioning engine. */
async function prepareWorkflow(deps: WorkflowTestDeps, context: ContextRecord, owner: string) {
  const selected = await runtimeModelSelection(deps.meta, context.id, context.org_id)
  if (!selected) return null
  const prior = await deps.meta.getRuntimeSetup(context.id, context.org_id)
  if (prior?.phase === "failed") {
    if (!(await deps.meta.retryRuntimeSetup(context.id, context.org_id, prior.revision)))
      return null
  } else if (prior) return prior
  const id = newId("rts")
  const at = new Date()
  return deps.meta.createRuntimeSetup(
    {
      id,
      org_id: context.org_id,
      context_id: context.id,
      agent_id: context.agent_id,
      created_by: owner,
      connection_id: null,
      model_connection_id: selected.connection.id,
      model_binding_revision: selected.binding.revision,
      api_url: deps.config.apiUrl,
      ortam_org_id: selected.connection.ortam_org_id,
      ortam_user_id: selected.connection.ortam_user_id,
      request_json: JSON.stringify({ ...runtimeSetupRequest(id), agent_connections: true }),
      deadline_at: new Date(at.getTime() + SETUP_TIMEOUT_MS).toISOString(),
    },
    at.toISOString(),
  )
}

export async function materializeWorkflowTests(deps: WorkflowTestDeps) {
  for (const request of await deps.meta.listPendingWorkflowTests()) {
    try {
      const fail = () => deps.meta.settleWorkflowTest(request.id, request.org_id, "failed")
      const existing = await deps.meta.getRun(request.id)
      if (existing?.org_id === request.org_id) {
        await deps.meta.settleWorkflowTest(request.id, request.org_id, "submitted")
        continue
      }
      if (Date.now() >= Date.parse(request.created_at) + SETUP_TIMEOUT_MS) {
        await deps.meta.cancelRuntimeSetup(
          request.context_id,
          request.org_id,
          new Date().toISOString(),
        )
        await fail()
        continue
      }
      const context = await deps.meta.getContext(request.context_id)
      if (!context || context.org_id !== request.org_id) {
        await fail()
        continue
      }
      const configuration = await workflowConfiguration(deps.meta, context)
      if (configuration.revision !== request.config_revision) {
        await fail()
        continue
      }
      const readiness = await workflowReadiness(
        deps.meta,
        deps.config,
        context,
        request.initiated_by,
        deps.fetcher,
      )
      // A temporary provider outage leaves the durable request intact; other lost grants cancel it.
      if (readiness.blockers.some((b) => b.code === "account_check_failed")) continue
      if (readiness.blockers.some((b) => b.code !== "preparation_failed")) {
        await fail()
        continue
      }
      if (!configuration.runtime) {
        const setup = await deps.meta.getRuntimeSetup(context.id, context.org_id)
        if (setup?.phase === "failed" && setup.created_at >= request.created_at) {
          await fail()
          continue
        }
        await prepareWorkflow(deps, context, request.initiated_by)
        continue
      }
      await deps.meta.projectWorkflowDraft(
        context.id,
        context.org_id,
        request.initiated_by,
        new Date().toISOString(),
      )
      if ((await workflowConfiguration(deps.meta, context)).revision !== request.config_revision) {
        await fail()
        continue
      }
      const input = JSON.parse(request.input_snapshot) as RuntimeRunInput
      await deps.meta.createRun({
        id: request.id,
        org_id: request.org_id,
        agent_id: context.agent_id,
        initiated_by: request.initiated_by,
        reason: "manual:runtime",
        runtime_id: configuration.runtime.id,
        input_snapshot: JSON.stringify({ ...input, workflow_revision: request.config_revision }),
      })
      await deps.meta.settleWorkflowTest(request.id, request.org_id, "submitted")
      deps.pokeRuntime?.()
    } catch (error) {
      log.warn("workflow test reconciliation deferred", {
        request: request.id,
        reason: runtimeFailureReason(error),
      })
    }
  }
}
