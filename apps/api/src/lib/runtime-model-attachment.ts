import type {
  ContextRuntimeRecord,
  MetaStore,
  RunAttemptRecord,
  RunRecord,
  RuntimeRunInput,
} from "@derive/core"
import type { AppDeps } from "../context"
import { managedModelClient, managedRuntimeClient, runtimeController } from "./runtime-controller"

/** The exclusive run attempt owns the entire stopped-machine transfer. Reconcile
 * cancellation too, so an ambiguous attachment cannot outlive ownership release.
 * Every remote mutation uses a sandbox version, fencing delayed old requests. */
export async function prepareRuntimeModel(
  deps: {
    meta: MetaStore
    config: NonNullable<AppDeps["runtime"]>
    secret: string
    fetcher?: typeof fetch
    now?: () => Date
  },
  run: RunRecord,
  attempt: RunAttemptRecord,
  runtime: ContextRuntimeRecord,
): Promise<ContextRuntimeRecord | null> {
  const input = JSON.parse(run.input_snapshot ?? "null") as RuntimeRunInput | null
  if (!input?.model_connection || attempt.startup_operation_id) return runtime
  const target = await deps.meta.getRuntimeModelConnection(input.model_connection.id, run.org_id)
  if (!target || target.api_url !== runtime.api_url || target.ortam_org_id !== runtime.ortam_org_id)
    throw new Error("Pinned model attachment identity is unavailable")
  const observer = await runtimeController(
    deps.meta,
    deps.config,
    deps.secret,
    runtime,
    deps.fetcher,
    true,
  )
  const sandbox = await observer.sandbox(runtime.sandbox_id, {
    organization_id: runtime.ortam_org_id,
    user_id: runtime.ortam_user_id,
  })
  // The desired account may already be attached and another pass may have resumed
  // compute. Record that receipt before considering a stop; a stale observer must
  // never undo the winning controller's resume. Only an actual transfer needs a stop.
  if (sandbox.agent_connections?.user_id === target.ortam_user_id)
    return deps.meta.applyRuntimeModelConnection(attempt.id, run.org_id, target.id)
  if (sandbox.state !== "stopped") {
    if (!attempt.stop_operation_id) {
      const operation = await observer.lifecycle(
        runtime.sandbox_id,
        "stop",
        `derive-${attempt.id}-model-stop`,
        {
          organization_id: runtime.ortam_org_id,
          user_id: runtime.ortam_user_id,
        },
      )
      await deps.meta.transitionRunAttempt(
        attempt.id,
        run.org_id,
        attempt.revision,
        { phase: "stopping", stop_operation_id: operation.id },
        (deps.now?.() ?? new Date()).toISOString(),
      )
    }
    return null
  }
  if (sandbox.agent_connections) {
    if (
      !attempt.model_source_user_id ||
      sandbox.agent_connections.user_id !== attempt.model_source_user_id
    )
      throw new Error("Machine carries an unexpected model account")
    const source = attempt.model_source_connection_id
      ? managedModelClient(
          deps.config,
          {
            id: attempt.model_source_connection_id,
            org_id: runtime.org_id,
            api_url: runtime.api_url,
          },
          deps.fetcher,
        )
      : managedRuntimeClient(deps.config, runtime.org_id, runtime.context_id, deps.fetcher)
    await source.setModelAttachment(sandbox, false, {
      organization_id: runtime.ortam_org_id,
      user_id: attempt.model_source_user_id,
    })
  } else {
    const client = managedModelClient(deps.config, target, deps.fetcher)
    await client.setModelAttachment(sandbox, true, {
      organization_id: target.ortam_org_id,
      user_id: target.ortam_user_id,
    })
  }
  return null // Verify the remote result before recording or resuming, including after lost responses.
}
