import type { Actor } from "@aniraga/open-artifact-protocol"
import { type ArtifactStore, HttpError } from "@aniraga/open-artifact-server/kit"
import { newId } from "./ids"
import type { MetaStore } from "./ports"
import { artifactCollection } from "./shared-state"

type State = Pick<
  ArtifactStore,
  "getState" | "countStateKeys" | "putState" | "appendActivity" | "listActivity"
>

export const artifactStoreState = (meta: MetaStore, actor?: Actor): State => ({
  getState: async (id, key) => {
    const row = await meta.getSharedState(id, key)
    if (!row) return null
    const items = artifactCollection.read(JSON.parse(row.json), { stored: true })
    if ("error" in items) throw new HttpError(500, "Stored shared state is invalid.")
    return {
      artifactId: id,
      key,
      items,
      version: row.version,
      updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
      updatedAt: row.updated_at,
    }
  },
  countStateKeys: (id) => meta.countSharedStateKeys(id),
  putState: async (row, expected) => {
    const by = row.updatedBy ?? actor
    if (!by) throw new HttpError(400, "State writes require authenticated attribution.")
    if (row.version !== expected + 1) throw new HttpError(400, "State version is invalid.")
    return !!(await meta.putSharedState({
      id: newId("state"),
      artifact_id: row.artifactId,
      key: row.key,
      json: JSON.stringify(row.items),
      expected_version: expected,
      updated_by_id: by.id,
      updated_by_name: by.name,
      updated_at: row.updatedAt ?? new Date().toISOString(),
    }))
  },
  appendActivity: (row, keep) =>
    meta.appendSharedStateActivity(
      {
        id: newId("sa"),
        artifact_id: row.artifactId,
        key: row.key,
        action: row.action === "setMine" ? "set_mine" : row.action,
        item_id: row.itemId,
        version: row.version,
        actor_id: row.actor.id,
        actor_name: row.actor.name,
        created_at: row.at,
      },
      keep,
    ),
  listActivity: async (id, key, limit) =>
    (await meta.listSharedStateActivity(id, key, limit)).map((row) => ({
      artifactId: row.artifact_id,
      key: row.key,
      action: row.action === "set_mine" ? "setMine" : row.action,
      itemId: row.item_id,
      version: row.version,
      actor: { id: row.actor_id, name: row.actor_name },
      at: row.created_at,
    })),
})
