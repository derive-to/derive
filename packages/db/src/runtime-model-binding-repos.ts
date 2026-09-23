import type {
  ContextRuntimeRecord,
  RuntimeModelBindingRecord,
  RuntimeRunInput,
  RuntimeStore,
} from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

type BindingStore = Pick<
  RuntimeStore,
  "getRuntimeModelBinding" | "saveRuntimeModelBinding" | "applyRuntimeModelConnection"
>

/** An existing grant, including a removed one, never falls back to legacy job credentials. */
export function runtimeModelGrant(contextId: SQL, orgId: SQL, input: RuntimeRunInput): SQL {
  const pin = input.model_connection
  return pin
    ? sql`EXISTS (SELECT 1 FROM runtime_model_binding b JOIN runtime_model_connection m
        ON m.id = b.model_connection_id AND m.org_id = b.org_id
        WHERE b.context_id = ${contextId} AND b.org_id = ${orgId}
          AND b.model_connection_id = ${pin.id} AND b.revision = ${pin.revision}
          AND m.revoked_at IS NULL AND m.provider = ${input.provider} AND b.granted_by = m.created_by)`
    : sql`NOT EXISTS (SELECT 1 FROM runtime_model_binding b WHERE b.context_id = ${contextId} AND b.org_id = ${orgId})`
}

export function runtimeModelBindingRepos(
  execute: (statement: SQL) => Promise<unknown[]>,
): BindingStore {
  const first = async <T>(statement: SQL) =>
    ((await execute(statement))[0] as T | undefined) ?? null
  return {
    getRuntimeModelBinding: (contextId, orgId) =>
      first<RuntimeModelBindingRecord>(
        sql`SELECT * FROM runtime_model_binding WHERE context_id = ${contextId} AND org_id = ${orgId}`,
      ),
    saveRuntimeModelBinding: async (input) => {
      if (
        new Date(input.at).toISOString() !== input.at ||
        (input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 0))
      )
        throw new Error("Invalid model grant revision or timestamp")
      return first<RuntimeModelBindingRecord>(sql`INSERT INTO runtime_model_binding
        (context_id, org_id, model_connection_id, granted_by, revision, updated_at)
        SELECT c.id, c.org_id, ${input.connectionId}, ${input.ownerId}, 0, ${input.at}
        FROM context c LEFT JOIN runtime_model_connection m ON m.id = ${input.connectionId} AND m.org_id = c.org_id
        WHERE c.id = ${input.contextId} AND c.org_id = ${input.orgId} AND c.import_source IS NULL
          AND (cast(${input.connectionId} AS text) IS NULL OR (m.created_by = ${input.ownerId} AND m.revoked_at IS NULL))
          AND (cast(${input.revision} AS integer) IS NULL OR EXISTS (SELECT 1 FROM runtime_model_binding b
            WHERE b.context_id = c.id AND b.org_id = c.org_id AND b.revision = ${input.revision}))
          AND NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = c.id AND rt.connection_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM runtime_setup s WHERE s.context_id = c.id AND s.connection_id IS NOT NULL)
        ON CONFLICT (context_id) DO UPDATE SET model_connection_id = excluded.model_connection_id,
          granted_by = excluded.granted_by, revision = runtime_model_binding.revision + 1, updated_at = excluded.updated_at
        WHERE runtime_model_binding.org_id = ${input.orgId} AND runtime_model_binding.revision = ${input.revision}
        RETURNING *`)
    },
    async applyRuntimeModelConnection(attemptId, orgId, connectionId) {
      const row = await first<{ input_snapshot: string }>(sql`SELECT r.input_snapshot FROM run r
        JOIN run_attempt a ON a.run_id = r.id AND a.org_id = r.org_id WHERE a.id = ${attemptId} AND a.org_id = ${orgId}`)
      const input = row ? (JSON.parse(row.input_snapshot) as RuntimeRunInput) : null
      if (input?.model_connection?.id !== connectionId) return null
      // This is an attachment receipt, not a fresh grant: revocation must not prevent
      // recording the identity needed to clean up a completed remote change.
      return first<ContextRuntimeRecord>(sql`UPDATE context_runtime SET model_connection_id = ${connectionId},
        ortam_user_id = (SELECT m.ortam_user_id FROM runtime_model_connection m WHERE m.id = ${connectionId} AND m.org_id = ${orgId})
        WHERE org_id = ${orgId} AND connection_id IS NULL
          AND EXISTS (SELECT 1 FROM run_attempt a WHERE a.id = ${attemptId} AND a.org_id = context_runtime.org_id
            AND a.runtime_id = context_runtime.id AND a.released_at IS NULL AND a.startup_operation_id IS NULL
            AND a.phase IN ('starting', 'stopping'))
          AND EXISTS (SELECT 1 FROM runtime_model_connection m WHERE m.id = ${connectionId} AND m.org_id = context_runtime.org_id
            AND m.api_url = context_runtime.api_url AND m.ortam_org_id = context_runtime.ortam_org_id)
        RETURNING *`)
    },
  }
}
