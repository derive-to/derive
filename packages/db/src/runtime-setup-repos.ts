import type { RuntimeSetupRecord, RuntimeStore } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

type SetupStore = Pick<
  RuntimeStore,
  | "createRuntimeSetup"
  | "getRuntimeSetup"
  | "listPendingRuntimeSetups"
  | "transitionRuntimeSetup"
  | "cancelRuntimeSetup"
>
const transitions: Record<RuntimeSetupRecord["phase"], RuntimeSetupRecord["phase"][]> = {
  queued: ["creating", "failed"],
  creating: ["provisioning"],
  provisioning: ["stopping", "deleting"],
  stopping: ["stopping", "awaiting_connection", "deleting"],
  awaiting_connection: ["binding", "deleting"],
  binding: ["ready"],
  deleting: ["deleting", "failed"],
  ready: [],
  failed: [],
}

/** Unique admission is shared by manual and automatic setup. Replaying an interrupted
 * insert uses the same owner; another mode cannot steal the Context between statements. */
export async function claimRuntimeOwner(
  execute: (statement: SQL) => Promise<unknown[]>,
  input: { context_id: string; org_id: string; connection_id: string; agent_id: string },
  owner: string,
) {
  await execute(sql`INSERT INTO runtime_owner (context_id, org_id, owner)
    SELECT c.id, c.org_id, ${owner} FROM context c
    JOIN connection cn ON cn.id = ${input.connection_id} AND cn.org_id = c.org_id
    WHERE c.id = ${input.context_id} AND c.org_id = ${input.org_id} AND c.agent_id = ${input.agent_id}
      AND c.import_source IS NULL AND cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = c.id)
    ON CONFLICT DO NOTHING RETURNING context_id`)
  return (
    (
      await execute(sql`SELECT context_id FROM runtime_owner WHERE context_id = ${input.context_id}
    AND org_id = ${input.org_id} AND owner = ${owner}`)
    ).length > 0
  )
}

export function runtimeSetupRepos(execute: (statement: SQL) => Promise<unknown[]>): SetupStore {
  const first = async (statement: SQL) =>
    (await execute(statement))[0] as RuntimeSetupRecord | undefined
  return {
    async createRuntimeSetup(input, at) {
      if (
        new Date(at).toISOString() !== at ||
        new Date(input.deadline_at).toISOString() !== input.deadline_at ||
        input.deadline_at <= at
      )
        throw new Error("Invalid setup deadline")
      if (!(await claimRuntimeOwner(execute, input, "setup"))) return null
      return (
        (await first(sql`INSERT INTO runtime_setup
        (id, org_id, context_id, agent_id, created_by, connection_id, api_url, ortam_org_id, ortam_user_id,
          request_json, phase, deadline_at, created_at, updated_at)
        SELECT ${input.id}, c.org_id, c.id, c.agent_id, ${input.created_by}, cn.id, ${input.api_url},
          ${input.ortam_org_id}, ${input.ortam_user_id}, ${input.request_json}, 'queued', ${input.deadline_at}, ${at}, ${at}
        FROM context c JOIN connection cn ON cn.id = ${input.connection_id} AND cn.org_id = c.org_id
        WHERE c.id = ${input.context_id} AND c.org_id = ${input.org_id} AND c.agent_id = ${input.agent_id}
          AND c.import_source IS NULL AND cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = c.id)
        ON CONFLICT DO NOTHING RETURNING *`)) ?? null
      )
    },
    async getRuntimeSetup(contextId, orgId) {
      return (
        (await first(
          sql`SELECT * FROM runtime_setup WHERE context_id = ${contextId} AND org_id = ${orgId}`,
        )) ?? null
      )
    },
    async listPendingRuntimeSetups(limit = 100) {
      return (await execute(sql`SELECT * FROM runtime_setup WHERE phase NOT IN ('ready', 'failed')
        ORDER BY updated_at, id LIMIT ${Math.max(1, Math.min(1000, limit))}`)) as RuntimeSetupRecord[]
    },
    async cancelRuntimeSetup(contextId, orgId, at) {
      // Binding and cancellation serialize in the store. Never delete a sandbox already handed to a runtime.
      await execute(sql`UPDATE runtime_setup SET cancelled_at = ${at}, revision = revision + 1, updated_at = ${at}
        WHERE context_id = ${contextId} AND org_id = ${orgId} AND cancelled_at IS NULL AND phase NOT IN ('binding', 'ready', 'failed')
          AND NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = runtime_setup.context_id) RETURNING id`)
    },
    async transitionRuntimeSetup(id, orgId, revision, change, at) {
      const prior = await first(
        sql`SELECT * FROM runtime_setup WHERE id = ${id} AND org_id = ${orgId}`,
      )
      if (!prior || prior.revision !== revision || !transitions[prior.phase].includes(change.phase))
        return null
      for (const key of [
        "sandbox_id",
        "create_operation_id",
        "stop_operation_id",
        "delete_operation_id",
      ] as const)
        if (
          change[key] !== undefined &&
          (!change[key] || (prior[key] && prior[key] !== change[key]))
        )
          return null
      const sandbox = change.sandbox_id ?? prior.sandbox_id
      const createOp = change.create_operation_id ?? prior.create_operation_id
      if (change.phase === "provisioning" && (!sandbox || !createOp)) return null
      if (change.phase === "creating" && (prior.cancelled_at || at >= prior.deadline_at))
        return null
      if (
        ["awaiting_connection", "binding"].includes(change.phase) &&
        (prior.cancelled_at || at >= prior.deadline_at)
      )
        return null
      if (change.phase === "failed" && prior.phase === "deleting" && !prior.delete_operation_id)
        return null
      return (
        (await first(sql`UPDATE runtime_setup SET phase = ${change.phase}, sandbox_id = ${sandbox},
        create_operation_id = ${createOp}, stop_operation_id = ${change.stop_operation_id ?? prior.stop_operation_id},
        delete_operation_id = ${change.delete_operation_id ?? prior.delete_operation_id}, revision = revision + 1, updated_at = ${at}
        WHERE id = ${id} AND org_id = ${orgId} AND revision = ${revision}
          AND (${change.phase} <> 'deleting' OR NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = runtime_setup.context_id))
          AND (${change.phase} <> 'ready' OR EXISTS (SELECT 1 FROM context_runtime rt
            WHERE rt.context_id = runtime_setup.context_id AND rt.sandbox_id = runtime_setup.sandbox_id)) RETURNING *`)) ??
        null
      )
    },
  }
}
