import type { RuntimeModelConnectionRecord, RuntimeStore } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

type ModelStore = Pick<
  RuntimeStore,
  | "createRuntimeModelConnection"
  | "getRuntimeModelConnection"
  | "listRuntimeModelConnections"
  | "renameRuntimeModelConnection"
  | "revokeRuntimeModelConnection"
>

const instant = (at: string) => {
  if (new Date(at).toISOString() !== at) throw new Error("Expected a canonical UTC timestamp")
  return at
}
const checkedName = (name: string) => {
  const value = name.trim()
  if (!value || value.length > 100)
    throw new Error("Model connection name must be 1–100 characters")
  return value
}

/** One SQL implementation for SQLite, Postgres and D1. No provider tokens enter this store. */
export function runtimeModelRepos(execute: (statement: SQL) => Promise<unknown[]>): ModelStore {
  const first = async (statement: SQL) =>
    ((await execute(statement))[0] as RuntimeModelConnectionRecord | undefined) ?? null
  const get: ModelStore["getRuntimeModelConnection"] = (id, orgId) =>
    first(sql`SELECT * FROM runtime_model_connection WHERE id = ${id} AND org_id = ${orgId}`)
  return {
    async createRuntimeModelConnection(input, at) {
      instant(at)
      if (input.provider !== "codex" && input.provider !== "claude-code")
        throw new Error("Unknown model provider")
      const row = await first(sql`INSERT INTO runtime_model_connection
        (id, org_id, created_by, name, provider, api_url, ortam_org_id, ortam_user_id, created_at, updated_at)
        VALUES (${input.id}, ${input.org_id}, ${input.created_by}, ${checkedName(input.name)},
          ${input.provider}, ${input.api_url}, ${input.ortam_org_id}, ${input.ortam_user_id}, ${at}, ${at})
        RETURNING *`)
      if (!row) throw new Error("Model connection was not created")
      return row
    },
    getRuntimeModelConnection: get,
    listRuntimeModelConnections: async (orgId, ownerId) =>
      (await execute(sql`SELECT * FROM runtime_model_connection
        WHERE org_id = ${orgId} AND created_by = ${ownerId} AND revoked_at IS NULL
        ORDER BY created_at, id`)) as RuntimeModelConnectionRecord[],
    renameRuntimeModelConnection: (id, orgId, revision, name, at) =>
      first(sql`UPDATE runtime_model_connection SET name = ${checkedName(name)},
        revision = revision + 1, updated_at = ${instant(at)}
        WHERE id = ${id} AND org_id = ${orgId} AND revision = ${revision} AND revoked_at IS NULL
        RETURNING *`),
    async revokeRuntimeModelConnection(id, orgId, at) {
      await execute(sql`UPDATE runtime_model_connection SET revoked_at = ${instant(at)},
        revision = revision + 1, updated_at = ${at}
        WHERE id = ${id} AND org_id = ${orgId} AND revoked_at IS NULL RETURNING id`)
      return get(id, orgId)
    },
  }
}
