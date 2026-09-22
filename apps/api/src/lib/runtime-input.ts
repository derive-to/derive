import type { ContextRecord, MetaStore, RuntimeRunInput } from "@derive/core"
import { readEnvironmentBindings } from "./context-environment"

export async function runtimeInput(
  meta: MetaStore,
  context: ContextRecord,
  task: Pick<RuntimeRunInput, "instruction" | "provider" | "model" | "schedule_revision">,
): Promise<RuntimeRunInput | null> {
  const manifest = (await meta.currentVersions([context.manifest_artifact_id]))[
    context.manifest_artifact_id
  ]
  if (!manifest) return null
  return {
    version: 1,
    ...task,
    context_id: context.id,
    manifest: {
      artifact_id: context.manifest_artifact_id,
      version: manifest.n,
      blob_key: manifest.blob_key,
    },
    connection_ids: JSON.parse(context.connection_ids ?? "[]"),
    environment_bindings: readEnvironmentBindings(context.environment_bindings),
  }
}
