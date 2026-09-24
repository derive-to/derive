import type { AutomationRecord, RuntimeStore } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

/** Schedule definitions remain Automations; this port binds their execution to a runtime. */
export function runtimeScheduleRepos(execute: (statement: SQL) => Promise<unknown[]>) {
  const first = async (statement: SQL): Promise<AutomationRecord | null> =>
    ((await execute(statement))[0] as AutomationRecord | undefined) ?? null
  const saveRuntimeSchedule: RuntimeStore["saveRuntimeSchedule"] = async (input) => {
    if (
      new Date(input.at).toISOString() !== input.at ||
      (input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 0))
    )
      throw new Error("Invalid schedule revision or timestamp")
    const trigger = JSON.stringify(
      input.cron === null
        ? { kind: "manual" }
        : { kind: "schedule", cron: input.cron, tz: input.timezone },
    )
    return first(sql`
      INSERT INTO automation (id, org_id, agent_id, context_id, runtime_id, created_by,
        trigger, instruction, provider, enabled, revision, created_at, updated_at)
      SELECT ${input.id}, rt.org_id, rt.agent_id, rt.context_id, rt.id, ${input.ownerId},
        ${trigger}, ${input.instruction}, ${input.provider}, ${input.enabled ? 1 : 0}, 0, ${input.at}, ${input.at}
      FROM context_runtime rt JOIN context c ON c.id = rt.context_id AND c.org_id = rt.org_id
      JOIN membership m ON m.org_id = rt.org_id AND m.user_id = ${input.ownerId}
      WHERE rt.id = ${input.runtimeId} AND rt.org_id = ${input.orgId} AND rt.disabled_at IS NULL
        AND c.agent_id = rt.agent_id AND (c.created_by = ${input.ownerId} OR m.role = 'owner')
        AND (cast(${input.revision} AS integer) IS NULL OR EXISTS (
          SELECT 1 FROM automation prior WHERE prior.runtime_id = rt.id AND prior.org_id = rt.org_id))
      ON CONFLICT (runtime_id) DO UPDATE SET trigger = excluded.trigger,
        instruction = excluded.instruction, provider = excluded.provider, enabled = excluded.enabled,
        created_by = excluded.created_by, updated_at = excluded.updated_at, revision = automation.revision + 1
      WHERE automation.org_id = excluded.org_id AND automation.revision = ${input.revision ?? -1}
      RETURNING *`)
  }
  return {
    saveRuntimeSchedule,
    getRuntimeSchedule: (runtimeId: string, orgId: string) =>
      first(sql`SELECT * FROM automation WHERE runtime_id = ${runtimeId} AND org_id = ${orgId}`),
    listRuntimeSchedules: async (orgIds?: readonly string[]) =>
      orgIds?.length === 0
        ? []
        : ((await execute(sql`SELECT a.* FROM automation a
        JOIN context_runtime rt ON rt.id = a.runtime_id AND rt.org_id = a.org_id
        WHERE a.enabled = 1 AND rt.disabled_at IS NULL
          ${
            orgIds
              ? sql`AND a.org_id IN (${sql.join(
                  orgIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`
              : sql``
          }
        ORDER BY a.id`)) as AutomationRecord[]),
    cancelQueuedRuntimeRun: async (id: string, orgId: string, at: string) => {
      await execute(sql`UPDATE run SET status = 'failed', finished_at = ${at}
        WHERE id = ${id} AND org_id = ${orgId} AND runtime_id IS NOT NULL AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM run_attempt a WHERE a.run_id = run.id) RETURNING id`)
    },
  }
}
