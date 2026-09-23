import {
  type ContextRuntimeRecord,
  type ExecutionProvider,
  type MetaStore,
  roleAllows,
} from "@derive/core"
import type { AppDeps } from "../context"
import { managedModelClient, managedRuntimeClient } from "./runtime-controller"

/** Job consent belongs to the account owner, never to whoever happens to click Run. */
export async function runtimeModelSelection(meta: MetaStore, contextId: string, orgId: string) {
  const binding = await meta.getRuntimeModelBinding(contextId, orgId)
  const connection = binding?.model_connection_id
    ? await meta.getRuntimeModelConnection(binding.model_connection_id, orgId)
    : null
  if (
    !binding ||
    !connection ||
    connection.revoked_at ||
    binding.granted_by !== connection.created_by
  )
    return null
  const owner = await meta.getMembership(orgId, connection.created_by)
  if (!owner || !roleAllows(owner.role, "publish")) return null
  return { binding, connection }
}

/** Check the selected account using its saved identity, never the run initiator's. */
export async function runtimeModelReady(
  meta: MetaStore,
  config: NonNullable<AppDeps["runtime"]>,
  runtime: ContextRuntimeRecord,
  provider: ExecutionProvider,
  fetcher?: typeof fetch,
) {
  const binding = await meta.getRuntimeModelBinding(runtime.context_id, runtime.org_id)
  const selected = await runtimeModelSelection(meta, runtime.context_id, runtime.org_id)
  if (binding || runtime.model_connection_id) {
    if (
      !selected ||
      selected.connection.provider !== provider ||
      selected.connection.api_url !== runtime.api_url ||
      selected.connection.ortam_org_id !== runtime.ortam_org_id
    )
      return false
    const client = managedModelClient(config, selected.connection, fetcher)
    return client.hasModelConnection(provider, {
      organization_id: selected.connection.ortam_org_id,
      user_id: selected.connection.ortam_user_id,
    })
  }
  const client = managedRuntimeClient(config, runtime.org_id, runtime.context_id, fetcher)
  return client.hasModelConnection(provider, {
    organization_id: runtime.ortam_org_id,
    user_id: runtime.ortam_user_id,
  })
}
