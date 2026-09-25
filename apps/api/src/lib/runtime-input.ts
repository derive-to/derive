import type { ContextRecord, MetaStore, RuntimeRunInput } from "@derive/core"
import { readEnvironmentBindings } from "./context-environment"
import { credentialRevision } from "./credentials"

export async function runtimeInput(
  meta: MetaStore,
  context: ContextRecord,
  task: Pick<RuntimeRunInput, "instruction" | "provider" | "model" | "schedule_revision">,
): Promise<RuntimeRunInput | null> {
  const manifest = (await meta.currentVersions([context.manifest_artifact_id]))[
    context.manifest_artifact_id
  ]
  if (!manifest) return null
  const binding = await meta.getRuntimeModelBinding(context.id, context.org_id)
  if (binding && !binding.model_connection_id) return null
  const environment = readEnvironmentBindings(context.environment_bindings)
  const connectionIds = JSON.parse(context.connection_ids ?? "[]") as string[]
  const connections = await meta.getConnectionsByIds([
    ...new Set([...connectionIds, ...Object.values(environment)]),
  ])
  return {
    credential_revisions: Object.fromEntries(
      connections
        .filter((cn) => cn.org_id === context.org_id && cn.kind === "secret")
        .map((cn) => [cn.id, credentialRevision(cn)]),
    ),
    version: 1,
    ...(binding?.model_connection_id
      ? { model_connection: { id: binding.model_connection_id, revision: binding.revision } }
      : {}),
    ...task,
    context_id: context.id,
    manifest: {
      artifact_id: context.manifest_artifact_id,
      version: manifest.n,
      blob_key: manifest.blob_key,
    },
    connection_ids: connectionIds,
    environment_bindings: environment,
  }
}
