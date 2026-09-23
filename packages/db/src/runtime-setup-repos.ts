import type { ContextRuntimeRecord, RuntimeSetupRecord, RuntimeStore } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

type SetupStore = Pick<
  RuntimeStore,
  | "bindRuntimeSetup"
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
  input: { context_id: string; org_id: string; connection_id: string | null; agent_id: string },
  owner: "manual" | "setup",
) {
  await execute(sql`INSERT INTO runtime_owner (context_id, org_id, owner)
    SELECT c.id, c.org_id, ${owner} FROM context c
    LEFT JOIN connection cn ON cn.id = ${input.connection_id} AND cn.org_id = c.org_id
    WHERE c.id = ${input.context_id} AND c.org_id = ${input.org_id} AND c.agent_id = ${input.agent_id}
      AND c.import_source IS NULL AND (cast(${input.connection_id} AS text) IS NULL OR (cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL))
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
  const instant = (at: string) => {
    if (new Date(at).toISOString() !== at) throw new Error("Expected a canonical UTC timestamp")
  }
  const first = async (statement: SQL) =>
    (await execute(statement))[0] as RuntimeSetupRecord | undefined
  return {
    async bindRuntimeSetup(id, orgId, at) {
      instant(at)
      // Binding commits consent before projection. Recover from either statement failing,
      // even if the source Context disappeared after handover (project it as disabled).
      await execute(sql`INSERT INTO context_runtime
        (id, org_id, context_id, agent_id, api_url, ortam_org_id, ortam_user_id, sandbox_id, connection_id, model_connection_id, disabled_at, created_at)
        SELECT ${`rt_${id}`}, s.org_id, s.context_id, s.agent_id, s.api_url, s.ortam_org_id, s.ortam_user_id,
          s.sandbox_id, s.connection_id, s.model_connection_id,
          CASE WHEN EXISTS (SELECT 1 FROM context c LEFT JOIN connection cn ON cn.id = s.connection_id AND cn.org_id = c.org_id
            WHERE c.id = s.context_id AND c.org_id = s.org_id AND c.agent_id = s.agent_id AND (s.connection_id IS NULL OR cn.status = 'active')
              AND (s.model_connection_id IS NULL OR EXISTS (SELECT 1 FROM runtime_model_binding b
                JOIN runtime_model_connection m ON m.id = b.model_connection_id AND m.org_id = b.org_id
                WHERE b.context_id = s.context_id AND b.org_id = s.org_id AND b.model_connection_id = s.model_connection_id
                  AND b.revision = s.model_binding_revision AND m.revoked_at IS NULL AND m.created_by = b.granted_by)))
            THEN NULL ELSE ${at} END, ${at}
        FROM runtime_setup s WHERE s.id = ${id} AND s.org_id = ${orgId}
          AND s.phase = 'binding' AND s.cancelled_at IS NULL
        ON CONFLICT DO NOTHING RETURNING id`)
      const rows = await execute(sql`SELECT rt.* FROM context_runtime rt JOIN runtime_setup s
        ON rt.context_id = s.context_id AND rt.org_id = s.org_id AND rt.sandbox_id = s.sandbox_id
          AND (rt.connection_id = s.connection_id OR (rt.connection_id IS NULL AND s.connection_id IS NULL)) AND rt.agent_id = s.agent_id
          AND (rt.model_connection_id = s.model_connection_id OR (rt.model_connection_id IS NULL AND s.model_connection_id IS NULL))
          AND rt.api_url = s.api_url AND rt.ortam_org_id = s.ortam_org_id AND rt.ortam_user_id = s.ortam_user_id
        WHERE s.id = ${id} AND s.org_id = ${orgId} AND s.phase = 'binding' AND s.cancelled_at IS NULL`)
      return (rows[0] as ContextRuntimeRecord | undefined) ?? null
    },
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
          request_json, phase, deadline_at, created_at, updated_at, model_connection_id, model_binding_revision)
        SELECT ${input.id}, c.org_id, c.id, c.agent_id, ${input.created_by}, ${input.connection_id}, ${input.api_url},
          ${input.ortam_org_id}, ${input.ortam_user_id}, ${input.request_json}, 'queued', ${input.deadline_at}, ${at}, ${at}, ${input.model_connection_id ?? null}, ${input.model_binding_revision ?? null}
        FROM context c LEFT JOIN connection cn ON cn.id = ${input.connection_id} AND cn.org_id = c.org_id
        WHERE c.id = ${input.context_id} AND c.org_id = ${input.org_id} AND c.agent_id = ${input.agent_id}
          AND c.import_source IS NULL AND (cast(${input.connection_id} AS text) IS NULL OR (cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL))
          AND (cast(${input.model_connection_id ?? null} AS text) IS NULL OR (cast(${input.connection_id} AS text) IS NULL AND EXISTS (
            SELECT 1 FROM runtime_model_binding b JOIN runtime_model_connection m ON m.id = b.model_connection_id AND m.org_id = b.org_id
            WHERE b.context_id = c.id AND b.org_id = c.org_id AND b.model_connection_id = ${input.model_connection_id ?? null}
              AND b.revision = ${input.model_binding_revision ?? null} AND m.revoked_at IS NULL AND m.created_by = b.granted_by
              AND m.api_url = ${input.api_url} AND m.ortam_org_id = ${input.ortam_org_id} AND m.ortam_user_id = ${input.ortam_user_id})))
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
      instant(at)
      // Binding and cancellation serialize in the store. Never delete a sandbox already handed to a runtime.
      await execute(sql`UPDATE runtime_setup SET cancelled_at = ${at}, revision = revision + 1, updated_at = ${at}
        WHERE context_id = ${contextId} AND org_id = ${orgId} AND cancelled_at IS NULL AND phase NOT IN ('binding', 'ready', 'failed')
          AND NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = runtime_setup.context_id) RETURNING id`)
    },
    async transitionRuntimeSetup(id, orgId, revision, change, at) {
      instant(at)
      const prior = await first(
        sql`SELECT * FROM runtime_setup WHERE id = ${id} AND org_id = ${orgId}`,
      )
      if (!prior || prior.revision !== revision || !transitions[prior.phase].includes(change.phase))
        return null
      const receiptPhase = {
        sandbox_id: "provisioning",
        create_operation_id: "provisioning",
        stop_operation_id: "stopping",
        delete_operation_id: "deleting",
      } as const
      for (const key of Object.keys(receiptPhase) as (keyof typeof receiptPhase)[])
        if (
          change[key] !== undefined &&
          (change.phase !== receiptPhase[key] ||
            !change[key] ||
            (prior[key] && prior[key] !== change[key]))
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
      return (
        (await first(sql`UPDATE runtime_setup SET phase = ${change.phase}, sandbox_id = ${sandbox},
        create_operation_id = ${createOp}, stop_operation_id = ${change.stop_operation_id ?? prior.stop_operation_id},
        delete_operation_id = ${change.delete_operation_id ?? prior.delete_operation_id}, revision = revision + 1, updated_at = ${at}
        WHERE id = ${id} AND org_id = ${orgId} AND revision = ${revision}
          AND (${change.phase} <> 'binding' OR model_connection_id IS NULL OR EXISTS (
            SELECT 1 FROM runtime_model_binding b JOIN runtime_model_connection m ON m.id = b.model_connection_id AND m.org_id = b.org_id
            WHERE b.context_id = runtime_setup.context_id AND b.org_id = runtime_setup.org_id
              AND b.model_connection_id = runtime_setup.model_connection_id AND b.revision = runtime_setup.model_binding_revision
              AND m.revoked_at IS NULL AND m.created_by = b.granted_by))
          AND (${change.phase} <> 'deleting' OR NOT EXISTS (SELECT 1 FROM context_runtime rt WHERE rt.context_id = runtime_setup.context_id))
          AND (${change.phase} <> 'ready' OR EXISTS (SELECT 1 FROM context_runtime rt
            WHERE rt.context_id = runtime_setup.context_id AND rt.sandbox_id = runtime_setup.sandbox_id)) RETURNING *`)) ??
        null
      )
    },
  }
}
