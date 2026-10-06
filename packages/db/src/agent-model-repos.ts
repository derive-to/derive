import type {
  AccountPatch,
  AccountRecord,
  AgentModelStore,
  AgentPatch,
  AgentRecord,
  JobExpect,
  JobMessageRecord,
  JobPatch,
  JobQuery,
  JobRecord,
  JobStatus,
  SkillUsageBucket,
  TriggerPatch,
  TriggerRecord,
} from "@derive/core"
import { DERIVE_AGENT_ID, WORKSPACE_ACCOUNT_OWNER } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

// The agent model's store, written ONCE as parameterised SQL that runs unchanged on SQLite, D1
// and Postgres (the runtime-repos pattern). The tables are declared in schema.ts / pg-schema.ts
// and classified in parity.ts, so their row shapes are still checked at compile time; what this
// file adds is the queries. Every claim is a single UPDATE … WHERE id IN (SELECT …) that re-checks
// the status in the outer WHERE, so on Postgres a second concurrent claim waits on the row lock,
// re-evaluates, and updates nothing rather than double-claiming; SQLite and D1 are single-writer.

type Exec = (statement: SQL) => Promise<unknown[]>

const OPEN: readonly JobStatus[] = ["queued", "running", "needs_you"]

const list = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )
const iso = () => new Date().toISOString()

/** Postgres returns SUM/COUNT as bigint strings; SQLite as numbers. */
const num = (v: unknown): number => (v == null ? 0 : Number(v))

/** Build `col = value` assignments from a patch, only for the columns a caller may set. */
const assignments = (patch: object, allowed: readonly string[]): SQL[] =>
  Object.entries(patch)
    .filter(([k, v]) => v !== undefined && allowed.includes(k))
    .map(([k, v]) => sql`${sql.identifier(k)} = ${v}`)

const AGENT_FIELDS = [
  "name",
  "role",
  "description",
  "instructions_artifact_id",
  "machine",
  "sandbox_id",
  "sandbox_state_json",
  "account_id",
  "connection_ids_json",
  "repositories_json",
  "environment_json",
  "ask_policy",
  "write_policy",
  "paused_at",
  "max_run_ms",
  "max_concurrency",
  "provider",
  "model",
] as const satisfies readonly (keyof AgentPatch)[]

const JOB_FIELDS = [
  "status",
  "needs_json",
  "lease_until",
  "attempt",
  "started_at",
  "finished_at",
  "cost_micro_usd",
  "report_artifact_id",
  "result_json",
  "meta_json",
  "dedupe_key",
] as const satisfies readonly (keyof JobPatch)[]

const TRIGGER_FIELDS = [
  "kind",
  "cron",
  "tz",
  "on_event",
  "instruction",
  "subject_json",
  "enabled",
] as const satisfies readonly (keyof TriggerPatch)[]

const ACCOUNT_FIELDS = [
  "kind",
  "name",
  "secret_enc",
  "hint",
  "status",
] as const satisfies readonly (keyof AccountPatch)[]

/** A Skill's runs: jobs of every agent whose instructions page is the Skill, bucketed by the
 *  Skill version that was current when each job opened. One query, same on every dialect. */
export const skillJobUsage = async (
  execute: Exec,
  skillArtifactId: string,
  orgId: string,
): Promise<SkillUsageBucket[]> => {
  const found = (await execute(sql`
    SELECT t.sv AS skill_version, count(*) AS n, max(t.created_at) AS last_used_at
    FROM (
      SELECT j.created_at,
        (SELECT max(v.n) FROM version v
          WHERE v.artifact_id = ${skillArtifactId} AND v.created_at <= j.created_at) AS sv
      FROM job j JOIN agent a ON a.id = j.agent_id AND a.org_id = j.org_id
      WHERE j.org_id = ${orgId} AND a.instructions_artifact_id = ${skillArtifactId}
    ) t
    WHERE t.sv IS NOT NULL
    GROUP BY t.sv
    ORDER BY t.sv DESC`)) as { skill_version: unknown; n: unknown; last_used_at: string }[]
  return found.map((r) => ({
    skill_version: num(r.skill_version),
    count: num(r.n),
    last_used_at: r.last_used_at,
  }))
}

export function agentModelRepos(execute: Exec): AgentModelStore<AgentRecord> {
  const rows = async <T>(statement: SQL): Promise<T[]> => (await execute(statement)) as T[]
  const first = async <T>(statement: SQL): Promise<T | null> =>
    (await rows<T>(statement))[0] ?? null

  const getJob = (id: string) => first<JobRecord>(sql`SELECT * FROM job WHERE id = ${id}`)

  return {
    // ---- Agents -----------------------------------------------------------------------
    async updateAgent(id, orgId, patch) {
      const set = assignments(patch, AGENT_FIELDS)
      if (set.length === 0)
        return first<AgentRecord>(sql`SELECT * FROM agent WHERE id = ${id} AND org_id = ${orgId}`)
      return first<AgentRecord>(sql`
        UPDATE agent SET ${sql.join(set, sql`, `)}
        WHERE id = ${id} AND org_id = ${orgId} RETURNING *`)
    },
    async touchAgentSeen(id, at) {
      await execute(sql`UPDATE agent SET seen_at = ${at} WHERE id = ${id} RETURNING id`)
    },

    // ---- Jobs -------------------------------------------------------------------------
    async createJob(j) {
      const now = iso()
      const row = await first<JobRecord>(sql`
        INSERT INTO job (id, org_id, agent_id, kind, parent_id, node_id, trigger_id, asked_by,
          payer_id, attended, instruction, subject_json, status, scheduled_for, attempt,
          dedupe_key, meta_json, created_at, updated_at)
        VALUES (${j.id}, ${j.org_id}, ${j.agent_id}, ${j.kind}, ${j.parent_id ?? null},
          ${j.node_id ?? null}, ${j.trigger_id ?? null}, ${j.asked_by ?? null},
          ${j.payer_id ?? null}, ${j.attended ?? 0},
          ${j.instruction}, ${j.subject_json ?? null}, 'queued', ${j.scheduled_for ?? null}, 0,
          ${j.dedupe_key ?? null}, ${j.meta_json ?? null}, ${now}, ${now})
        RETURNING *`)
      if (!row) throw new Error("job insert returned no row")
      return row
    },
    getJob,
    listJobs(q: JobQuery) {
      const where: SQL[] = [sql`org_id = ${q.orgId}`]
      if (q.agentId) where.push(sql`agent_id = ${q.agentId}`)
      if (q.status?.length) where.push(sql`status IN (${list(q.status)})`)
      if (q.kind?.length) where.push(sql`kind IN (${list(q.kind)})`)
      if (q.parentId) where.push(sql`parent_id = ${q.parentId}`)
      if (q.askedBy) where.push(sql`asked_by = ${q.askedBy}`)
      if (q.reportArtifactId) where.push(sql`report_artifact_id = ${q.reportArtifactId}`)
      if (q.subjectJson?.length) where.push(sql`subject_json IN (${list(q.subjectJson)})`)
      if (q.askedByOrAgent) {
        const { askedBy, agentIds } = q.askedByOrAgent
        where.push(
          agentIds.length
            ? sql`(asked_by = ${askedBy} OR agent_id IN (${list(agentIds)}))`
            : sql`asked_by = ${askedBy}`,
        )
      }
      if (q.viewer !== undefined)
        where.push(sql`(agent_id <> ${DERIVE_AGENT_ID} OR asked_by = ${q.viewer})`)
      if (q.since) where.push(sql`created_at >= ${q.since}`)
      if (q.before) where.push(sql`created_at < ${q.before}`)
      const limit = Math.max(1, Math.min(500, q.limit ?? 50))
      return rows<JobRecord>(sql`
        SELECT * FROM job WHERE ${sql.join(where, sql` AND `)}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
    },
    claimJobs(agentId, limit, leaseUntil, now, heldPayers) {
      const n = Math.max(1, Math.min(50, limit))
      // The pool is `null` on the row; compare through '' so one NOT IN covers both.
      const held = heldPayers?.length
        ? sql`AND coalesce(payer_id, '') NOT IN (${list(heldPayers.map((p) => p ?? ""))})`
        : sql``
      return rows<JobRecord>(sql`
        UPDATE job SET status = 'running', lease_until = ${leaseUntil}, started_at = ${now},
          updated_at = ${now}
        WHERE status = 'queued' AND id IN (
          SELECT id FROM job WHERE agent_id = ${agentId} AND status = 'queued' AND attended = 0
            AND kind <> 'graph'
            AND (scheduled_for IS NULL OR scheduled_for <= ${now})
            AND (machine_phase IS NULL OR machine_phase = 'released') ${held}
          ORDER BY created_at, id LIMIT ${n})
        RETURNING *`)
    },
    claimJob(id, leaseUntil, now) {
      return first<JobRecord>(sql`
        UPDATE job SET status = 'running', lease_until = ${leaseUntil}, started_at = ${now},
          updated_at = ${now}
        WHERE id = ${id} AND status = 'queued' RETURNING *`)
    },
    async updateJob(id, patch, expect?: JobExpect) {
      const set = assignments(patch, JOB_FIELDS)
      const now = iso()
      set.push(sql`updated_at = ${now}`)
      const where: SQL[] = [sql`id = ${id}`]
      if (expect?.status !== undefined) {
        const s = typeof expect.status === "string" ? [expect.status] : expect.status
        where.push(sql`status IN (${list(s)})`)
      }
      if (expect && "started_at" in expect)
        where.push(
          expect.started_at === null
            ? sql`started_at IS NULL`
            : sql`started_at = ${expect.started_at}`,
        )
      if (expect?.updated_at !== undefined) where.push(sql`updated_at = ${expect.updated_at}`)
      if (expect && "meta_json" in expect)
        where.push(
          expect.meta_json === null ? sql`meta_json IS NULL` : sql`meta_json = ${expect.meta_json}`,
        )
      if (expect && "needs_json" in expect)
        where.push(
          expect.needs_json === null
            ? sql`needs_json IS NULL`
            : sql`needs_json = ${expect.needs_json}`,
        )
      return first<JobRecord>(sql`
        UPDATE job SET ${sql.join(set, sql`, `)}
        WHERE ${sql.join(where, sql` AND `)} RETURNING *`)
    },
    async countRunningJobs(agentId, now) {
      const r = await first<{ n: unknown }>(sql`
        SELECT count(*) AS n FROM job
        WHERE agent_id = ${agentId} AND status = 'running' AND lease_until > ${now}`)
      return num(r?.n)
    },
    async reclaimStaleJobs(now, maxAttempts, orgIds) {
      if (orgIds?.length === 0) return { requeued: [], lost: [] }
      const scope = orgIds ? sql`AND org_id IN (${list(orgIds)})` : sql``
      // Attended jobs are served in-process by the request that asked; a lapsed one is not
      // retried by anybody, so it is lost rather than requeued for a runner that never sees it.
      const lost = await rows<JobRecord>(sql`
        UPDATE job SET status = 'lost', finished_at = ${now}, lease_until = NULL,
          dedupe_key = NULL, updated_at = ${now}
        WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ${now})
          AND (attempt + 1 >= ${maxAttempts} OR attended = 1) ${scope}
        RETURNING *`)
      const requeued = await rows<JobRecord>(sql`
        UPDATE job SET status = 'queued', attempt = attempt + 1, lease_until = NULL,
          started_at = NULL, updated_at = ${now}
        WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ${now})
          AND attempt + 1 < ${maxAttempts} AND attended = 0 ${scope}
        RETURNING *`)
      return { requeued, lost }
    },
    listQueuedDeriveJobs(limit, orgIds) {
      if (orgIds?.length === 0) return Promise.resolve([])
      const scope = orgIds ? sql`AND j.org_id IN (${list(orgIds)})` : sql``
      const now = iso()
      return rows<JobRecord>(sql`
        SELECT j.* FROM job j JOIN agent a ON a.id = j.agent_id AND a.org_id = j.org_id
        WHERE j.status = 'queued' AND j.attended = 0 AND j.kind <> 'graph' AND a.machine = 'derive'
          AND a.paused_at IS NULL AND (j.scheduled_for IS NULL OR j.scheduled_for <= ${now}) ${scope}
        ORDER BY j.created_at, j.id LIMIT ${Math.max(1, Math.min(200, limit))}`)
    },
    latestJobForTrigger(triggerId) {
      return first<JobRecord>(sql`
        SELECT * FROM job WHERE trigger_id = ${triggerId} AND scheduled_for IS NOT NULL
        ORDER BY scheduled_for DESC LIMIT 1`)
    },
    findOpenJobByDedupe(agentId, askedBy, dedupeKey) {
      return first<JobRecord>(sql`
        SELECT * FROM job WHERE agent_id = ${agentId} AND dedupe_key = ${dedupeKey}
          AND ${askedBy === null ? sql`asked_by IS NULL` : sql`asked_by = ${askedBy}`}
          AND status IN (${list(OPEN)})
        ORDER BY created_at DESC LIMIT 1`)
    },
    // ---- Derive machines ---------------------------------------------------------------
    async transitionAgentSandbox(id, orgId, expectRev, next) {
      const set: SQL[] = [sql`sandbox_phase = ${next.phase}`, sql`sandbox_rev = sandbox_rev + 1`]
      if (next.state_json !== undefined) set.push(sql`sandbox_state_json = ${next.state_json}`)
      if (next.sandbox_id !== undefined) set.push(sql`sandbox_id = ${next.sandbox_id}`)
      return first<AgentRecord>(sql`
        UPDATE agent SET ${sql.join(set, sql`, `)}
        WHERE id = ${id} AND org_id = ${orgId} AND sandbox_rev = ${expectRev} RETURNING *`)
    },
    listAgentsInSandboxPhase(phases, limit) {
      if (phases.length === 0) return Promise.resolve([])
      return rows<AgentRecord>(sql`
        SELECT * FROM agent WHERE sandbox_phase IN (${list(phases)})
        ORDER BY id LIMIT ${Math.max(1, Math.min(200, limit))}`)
    },
    async transitionJobMachine(id, expectRev, next) {
      const set: SQL[] = [
        sql`machine_phase = ${next.phase}`,
        sql`machine_rev = machine_rev + 1`,
        sql`updated_at = ${iso()}`,
      ]
      if (next.machine_json !== undefined) set.push(sql`machine_json = ${next.machine_json}`)
      return first<JobRecord>(sql`
        UPDATE job SET ${sql.join(set, sql`, `)}
        WHERE id = ${id} AND machine_rev = ${expectRev} RETURNING *`)
    },
    listMachineJobs(limit) {
      return rows<JobRecord>(sql`
        SELECT * FROM job WHERE machine_phase IS NOT NULL AND machine_phase <> 'released'
        ORDER BY created_at, id LIMIT ${Math.max(1, Math.min(200, limit))}`)
    },
    listOpenGraphJobs(limit) {
      return rows<JobRecord>(sql`
        SELECT * FROM job WHERE kind = 'graph' AND status IN ('queued', 'running')
        ORDER BY updated_at, id LIMIT ${Math.max(1, Math.min(200, limit))}`)
    },
    async addJobCost(id, microUsd) {
      await first(sql`
        UPDATE job SET cost_micro_usd = coalesce(cost_micro_usd, 0) + ${microUsd}
        WHERE id = ${id} RETURNING id`)
    },
    async sumJobCostSince(orgId, since, payer) {
      const r = await first<{ n: unknown }>(sql`
        SELECT coalesce(sum(cost_micro_usd), 0) AS n FROM job
        WHERE org_id = ${orgId} AND created_at >= ${since} AND cost_micro_usd IS NOT NULL
          ${payer ? sql`AND payer_id = ${payer}` : sql``}`)
      return num(r?.n)
    },
    async revokeAgentsCreatedBy(userId, now) {
      // A stored token is a SHA-256 hex digest; 'revoked:<id>' is never one, so no key matches,
      // and the agent id keeps the unique index satisfied.
      await execute(sql`
        UPDATE agent SET token = ${"revoked:"} || id, paused_at = coalesce(paused_at, ${now})
        WHERE created_by = ${userId} RETURNING id`)
    },
    async pauseAgentsCreatedBy(userId, orgId, now) {
      const inOrg = orgId ? sql`AND org_id = ${orgId}` : sql``
      await execute(sql`
        UPDATE agent SET paused_at = ${now}
        WHERE created_by = ${userId} AND paused_at IS NULL ${inOrg} RETURNING id`)
    },
    async addJobMessage(m) {
      // A transcript is ordered by created_at, and two messages written in the same millisecond
      // would otherwise tie and fall back to a random id. Stamp strictly after the last one.
      const last = await first<{ created_at: string }>(sql`
        SELECT created_at FROM job_message WHERE job_id = ${m.job_id}
        ORDER BY created_at DESC LIMIT 1`)
      let stamp = iso()
      if (last && last.created_at >= stamp)
        stamp = new Date(new Date(last.created_at).getTime() + 1).toISOString()
      const row = await first<JobMessageRecord>(sql`
        INSERT INTO job_message (id, job_id, author_kind, author_id, body_md, meta_json, created_at)
        VALUES (${m.id}, ${m.job_id}, ${m.author_kind}, ${m.author_id}, ${m.body_md},
          ${m.meta_json ?? null}, ${stamp})
        RETURNING *`)
      if (!row) throw new Error("job message insert returned no row")
      return row
    },
    listJobMessages(jobId) {
      return rows<JobMessageRecord>(sql`
        SELECT * FROM job_message WHERE job_id = ${jobId} ORDER BY created_at, id`)
    },
    listRecentAgentJobMessages(limit) {
      return rows<Pick<JobMessageRecord, "job_id" | "created_at" | "meta_json">>(sql`
        SELECT job_id, created_at, meta_json FROM job_message
        WHERE author_id = ${DERIVE_AGENT_ID} AND author_kind = 'agent'
        ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`)
    },

    // ---- Triggers ---------------------------------------------------------------------
    async createTrigger(t) {
      const now = iso()
      const row = await first<TriggerRecord>(sql`
        INSERT INTO agent_trigger (id, org_id, agent_id, kind, cron, tz, on_event, instruction,
          subject_json, enabled, revision, created_at, updated_at)
        VALUES (${t.id}, ${t.org_id}, ${t.agent_id}, ${t.kind}, ${t.cron ?? null}, ${t.tz ?? null},
          ${t.on_event ?? null}, ${t.instruction}, ${t.subject_json ?? null}, ${t.enabled ?? 1}, 0,
          ${now}, ${now})
        RETURNING *`)
      if (!row) throw new Error("trigger insert returned no row")
      return row
    },
    getTrigger(id) {
      return first<TriggerRecord>(sql`SELECT * FROM agent_trigger WHERE id = ${id}`)
    },
    listTriggers(orgId, agentId) {
      return rows<TriggerRecord>(sql`
        SELECT * FROM agent_trigger WHERE org_id = ${orgId}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
        ORDER BY created_at, id`)
    },
    listEnabledScheduleTriggers(orgIds) {
      if (orgIds?.length === 0) return Promise.resolve([])
      return rows<TriggerRecord>(sql`
        SELECT * FROM agent_trigger WHERE enabled = 1 AND kind = 'schedule' AND cron IS NOT NULL
          ${orgIds ? sql`AND org_id IN (${list(orgIds)})` : sql``}
        ORDER BY created_at, id`)
    },
    updateTrigger(id, orgId, patch) {
      const set = assignments(patch, TRIGGER_FIELDS)
      set.push(sql`revision = revision + 1`, sql`updated_at = ${iso()}`)
      return first<TriggerRecord>(sql`
        UPDATE agent_trigger SET ${sql.join(set, sql`, `)}
        WHERE id = ${id} AND org_id = ${orgId} RETURNING *`)
    },
    async deleteTrigger(id, orgId) {
      const gone = await rows(
        sql`DELETE FROM agent_trigger WHERE id = ${id} AND org_id = ${orgId} RETURNING id`,
      )
      return gone.length > 0
    },

    // ---- Accounts ---------------------------------------------------------------------
    async createAccount(a) {
      const now = iso()
      const row = await first<AccountRecord>(sql`
        INSERT INTO model_account (id, org_id, user_id, provider, kind, name, secret_enc, hint,
          status, created_at, updated_at)
        VALUES (${a.id}, ${a.org_id}, ${a.user_id}, ${a.provider}, ${a.kind}, ${a.name ?? null},
          ${a.secret_enc ?? null}, ${a.hint ?? null}, ${a.status ?? "not_checked"}, ${now}, ${now})
        RETURNING *`)
      if (!row) throw new Error("account insert returned no row")
      return row
    },
    getAccount(id) {
      return first<AccountRecord>(sql`SELECT * FROM model_account WHERE id = ${id}`)
    },
    listAccounts(orgId, userId) {
      return rows<AccountRecord>(sql`
        SELECT * FROM model_account WHERE org_id = ${orgId}
          ${userId ? sql`AND user_id IN (${userId}, ${WORKSPACE_ACCOUNT_OWNER})` : sql``}
        ORDER BY created_at, id`)
    },
    updateAccount(id, orgId, patch) {
      const set = assignments(patch, ACCOUNT_FIELDS)
      set.push(sql`updated_at = ${iso()}`)
      return first<AccountRecord>(sql`
        UPDATE model_account SET ${sql.join(set, sql`, `)}
        WHERE id = ${id} AND org_id = ${orgId} RETURNING *`)
    },
    async deleteAccount(id, orgId) {
      const gone = await rows(
        sql`DELETE FROM model_account WHERE id = ${id} AND org_id = ${orgId} RETURNING id`,
      )
      return gone.length > 0
    },
  }
}
