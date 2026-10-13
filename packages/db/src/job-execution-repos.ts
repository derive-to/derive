import {
  type AgentRecord,
  isJobOpen,
  type JobCommandReceipt,
  type JobEventRecord,
  type JobExecutionStore,
  type JobNeeds,
  type JobRecord,
  type JobResult,
  type JobTurnRecord,
  type JobTurnSummary,
  newId,
  questionHistory,
} from "@derive/core"
import { type SQL, sql } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { agentModelRepos } from "./agent-model-repos"
import type { PG_SCHEMA } from "./pg-schema"

// Ordinary task reads never fetch encrypted native conversation files.
const summaryColumns = sql`t.id, t.job_id, t.org_id, t.ordinal, t.actor_id, t.body_md,
  t.execution_json, t.status, t.session_id, (t.checkpoint_enc IS NOT NULL) AS has_checkpoint,
  t.result_json, t.body_result_md, t.created_at, t.finished_at`

const capacityAvailable = async (
  execute: (q: SQL) => Promise<unknown[]>,
  org: string,
  globalLimit: number,
  workspaceLimit: number,
) => {
  await execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('derive-cloud-capacity', 0))`)
  const count = (
    await execute(sql`SELECT
    (SELECT count(*) FROM job WHERE machine_phase IS NOT NULL AND machine_phase NOT IN ('released', 'parked')) +
    (SELECT count(*) FROM agent WHERE sandbox_phase IN ('creating', 'provisioning', 'stopping', 'deleting')) AS total,
    (SELECT count(*) FROM job WHERE org_id = ${org} AND machine_phase IS NOT NULL AND machine_phase NOT IN ('released', 'parked')) +
    (SELECT count(*) FROM agent WHERE org_id = ${org} AND sandbox_phase IN ('creating', 'provisioning', 'stopping', 'deleting')) AS workspace`)
  )[0] as { total: string; workspace: string }
  return Number(count.total) < globalLimit && Number(count.workspace) < workspaceLimit
}

/** Transactions share the Job row with the existing lifecycle. No second task store. */
export const jobExecutionRepos = (
  db: NodePgDatabase<typeof PG_SCHEMA>,
): JobExecutionStore<AgentRecord> => ({
  async receipt(org, source, key) {
    const r = await db.execute(sql`SELECT * FROM job_command
      WHERE org_id = ${org} AND source = ${source} AND command_key = ${key}`)
    return (r.rows[0] as unknown as JobCommandReceipt | undefined) ?? null
  },
  async command(input) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify([input.org_id, input.source, input.key])}, 0))`)
      if (input.source.startsWith("schedule:"))
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.org_id, input.source])}, 0))`,
        )
      const found = (
        await tx.execute(sql`SELECT * FROM job_command WHERE
        org_id = ${input.org_id} AND source = ${input.source} AND command_key = ${input.key}`)
      ).rows[0] as unknown as JobCommandReceipt | undefined
      if (found) {
        if (found.request_hash !== input.request_hash || found.actor_id !== input.actor_id)
          return {
            receipt: {
              ...found,
              error: "This request key belongs to another command.",
              status_code: 409,
              job_id: null,
              turn_id: null,
            },
            job: null,
            replayed: true,
            applied: false,
          }
        const job = found.job_id
          ? ((
              await tx.execute(
                sql`SELECT * FROM job WHERE id = ${found.job_id} AND org_id = ${input.org_id}`,
              )
            ).rows[0] as unknown as JobRecord | undefined)
          : null
        return { receipt: found, job: job ?? null, replayed: true, applied: false }
      }
      const now = new Date().toISOString()
      const repos = agentModelRepos(async (s) => (await tx.execute(s)).rows)
      let job: JobRecord | null = null
      let turnId: string | null = null
      let applied = false
      let refusal = input.refusal
      if (!refusal && input.intent !== "start") {
        job =
          ((
            await tx.execute(sql`SELECT * FROM job WHERE id = ${input.job_id}
          AND org_id = ${input.org_id} FOR UPDATE`)
          ).rows[0] as unknown as JobRecord | undefined) ?? null
        if (!job) refusal = { error: "This task is no longer available.", status: 410 }
        else if (input.intent !== "cancel" && job.status === "cancelled")
          refusal = {
            error: "This task is stopped. Start a fresh task to work again.",
            status: 409,
          }
        else if (
          input.intent !== "cancel" &&
          Number(
            (await tx.execute(sql`SELECT count(*) AS n FROM job_turn WHERE job_id = ${job.id}`))
              .rows[0]?.n,
          ) >= 200
        )
          refusal = {
            error: "This task has 200 turns. Start a fresh task to keep working.",
            status: 409,
          }
        else if (input.intent === "answer" && job.status !== "needs_you")
          refusal = { error: "This task is not waiting for an answer.", status: 409 }
        else if (
          input.intent === "answer" &&
          (JSON.parse(job.needs_json ?? "{}") as { question_id?: string }).question_id !==
            input.question_id
        )
          refusal = { error: "This question changed. Refresh before answering.", status: 409 }
        else if (input.intent === "retry" && !["failed", "lost"].includes(job.status))
          refusal = { error: "This task does not need a retry.", status: 409 }
      }
      if (!refusal && input.intent === "start" && input.job.trigger_id) {
        job =
          ((
            await tx.execute(sql`SELECT * FROM job WHERE org_id = ${input.org_id}
          AND trigger_id = ${input.job.trigger_id} AND status = 'queued'
          ORDER BY scheduled_for DESC LIMIT 1 FOR UPDATE`)
          ).rows[0] as unknown as JobRecord | undefined) ?? null
        if (job) {
          const meta = JSON.parse(job.meta_json ?? "{}") as { coalesced_until?: string }
          job = await repos.updateJob(job.id, {
            meta_json: JSON.stringify({ ...meta, coalesced_until: input.job.scheduled_for }),
          })
        }
      }
      const coalesced = !!job && input.intent === "start"
      // A refused schedule window still needs a visible task. It spends no compute.
      if (
        refusal &&
        input.intent === "start" &&
        input.source === `schedule:${input.job.trigger_id}`
      ) {
        job = await repos.createJob(input.job)
        applied = true
        job = await repos.updateJob(job.id, {
          status: "failed",
          finished_at: now,
          result_json: JSON.stringify({ failure: { reason: refusal.error, retryable: true } }),
        })
      }
      if (!refusal && input.intent === "start" && !job) {
        job = await repos.createJob(input.job)
        job = await repos.updateJob(job.id, {
          result_json: JSON.stringify({ claim_ledger_version: 1 }),
        })
        applied = true
      }
      if (!refusal && job) {
        if (input.intent === "cancel") {
          if (isJobOpen(job.status)) {
            await tx.execute(sql`UPDATE job_turn SET status = 'cancelled', finished_at = ${now}
            WHERE job_id = ${job.id} AND status IN ('queued', 'running')`)
            job = await repos.updateJob(job.id, {
              status: "cancelled",
              finished_at: now,
              lease_until: null,
            })
            applied = true
          }
        } else if (!coalesced) {
          if (!input.execution) throw new Error("admitted work needs an execution selection")
          const order = (
            await tx.execute(sql`SELECT coalesce(max(ordinal), 0) + 1 AS ordinal
            FROM job_turn WHERE job_id = ${job.id}`)
          ).rows[0] as { ordinal: number }
          turnId = newId("jt")
          applied = true
          await tx.execute(sql`INSERT INTO job_turn
            (id, job_id, org_id, ordinal, actor_id, body_md, execution_json, status, created_at)
            VALUES (${turnId}, ${job.id}, ${input.org_id}, ${Number(order.ordinal)},
              ${input.actor_id}, ${input.body}, ${JSON.stringify(input.execution)}, 'queued', ${now})`)
          await repos.addJobMessage({
            id: newId("jm"),
            job_id: job.id,
            author_kind: "asker",
            author_id: input.actor_id ?? job.agent_id,
            body_md: input.body,
            meta_json: JSON.stringify({ turn_id: turnId, source: input.source }),
          })
          if (job.status !== "queued" && job.status !== "running")
            job = await repos.updateJob(job.id, {
              status: "queued",
              needs_json: null,
              finished_at: null,
              lease_until: null,
              started_at: null,
              attempt: 0,
            })
        }
      }
      const receipt: JobCommandReceipt = {
        org_id: input.org_id,
        source: input.source,
        command_key: input.key,
        actor_id: input.actor_id,
        request_hash: input.request_hash,
        job_id: job?.id ?? null,
        turn_id: turnId,
        error: refusal?.error ?? null,
        status_code: refusal?.status ?? 200,
        created_at: now,
      }
      await tx.execute(sql`INSERT INTO job_command
        (org_id, source, command_key, actor_id, request_hash, job_id, turn_id, error, status_code, created_at)
        VALUES (${receipt.org_id}, ${receipt.source}, ${receipt.command_key}, ${receipt.actor_id},
          ${receipt.request_hash}, ${receipt.job_id}, ${receipt.turn_id}, ${receipt.error}, ${receipt.status_code}, ${now})`)
      return { receipt, job, replayed: false, applied }
    })
  },
  async turns(jobId, orgId) {
    return (
      await db.execute(sql`SELECT ${summaryColumns}, t.started_at FROM job_turn t WHERE t.job_id = ${jobId}
      AND t.org_id = ${orgId} ORDER BY t.ordinal LIMIT 200`)
    ).rows as unknown as JobTurnSummary[]
  },
  async claimed(jobId, orgId, startedAt) {
    const out =
      await db.execute(sql`SELECT ${summaryColumns}, ${startedAt} AS started_at, r.attempt_index
      FROM job_turn t LEFT JOIN job_turn_receipt r ON r.turn_id = t.id AND r.started_at = ${startedAt}
      WHERE t.job_id = ${jobId} AND t.org_id = ${orgId}
      AND (r.turn_id IS NOT NULL OR t.started_at = ${startedAt}) LIMIT 1`)
    return (
      (out.rows[0] as unknown as (JobTurnSummary & { attempt_index: number | null }) | undefined) ??
      null
    )
  },
  async checkpoint(jobId, orgId, beforeOrdinal) {
    const out = await db.execute(sql`SELECT session_id, checkpoint_enc FROM job_turn
      WHERE job_id = ${jobId} AND org_id = ${orgId} AND ordinal < ${beforeOrdinal}
      AND session_id IS NOT NULL AND checkpoint_enc IS NOT NULL ORDER BY ordinal DESC LIMIT 1`)
    return (out.rows[0] as { session_id: string; checkpoint_enc: string } | undefined) ?? null
  },
  async events(jobId, orgId) {
    return (
      await db.execute(sql`SELECT e.* FROM job_event e JOIN job_turn t ON t.id = e.turn_id
      WHERE t.job_id = ${jobId} AND t.org_id = ${orgId} ORDER BY t.ordinal, e.seq LIMIT 1000`)
    ).rows as unknown as JobEventRecord[]
  },
  async append(jobId, orgId, turnId, startedAt, events) {
    return db.transaction(async (tx) => {
      const job = (
        await tx.execute(sql`SELECT id FROM job WHERE id = ${jobId} AND org_id = ${orgId}
        AND started_at = ${startedAt} AND status = 'running' FOR UPDATE`)
      ).rows[0]
      if (!job) return false
      const turn = (
        await tx.execute(sql`SELECT id FROM job_turn WHERE id = ${turnId}
        AND job_id = ${jobId} AND started_at = ${startedAt} AND status = 'running'`)
      ).rows[0]
      if (!turn) return false
      for (const event of events)
        await tx.execute(sql`INSERT INTO job_event (turn_id, seq, kind)
        VALUES (${turnId}, ${event.seq}, ${event.kind}) ON CONFLICT DO NOTHING`)
      return true
    })
  },
  async claim(jobId, orgId, startedAt) {
    return db.transaction(async (tx) => {
      const job = (
        await tx.execute(sql`SELECT * FROM job WHERE id = ${jobId}
        AND org_id = ${orgId} AND status = 'running' AND started_at = ${startedAt}
        FOR UPDATE`)
      ).rows[0] as unknown as JobRecord | undefined
      if (!job) return null
      const turn = (
        await tx.execute(sql`SELECT * FROM job_turn WHERE job_id = ${jobId}
        AND status IN ('queued', 'running') ORDER BY ordinal LIMIT 1 FOR UPDATE`)
      ).rows[0] as unknown as JobTurnRecord | undefined
      if (!turn) return null
      const receipt = await tx.execute(sql`INSERT INTO job_turn_receipt
        (turn_id, started_at, result_json, reported, attempt_index)
        SELECT ${turn.id}, ${startedAt}, '{}', 0,
          coalesce(max(coalesce(r.attempt_index, (r.result_json::jsonb -> 'runs' -> 0 ->> 'attempt')::integer)), -1) + 1
        FROM job_turn_receipt r JOIN job_turn t ON t.id = r.turn_id WHERE t.job_id = ${jobId}
        ON CONFLICT DO NOTHING RETURNING attempt_index`)
      const receiptRow = receipt.rows[0]
      if (receiptRow) {
        const result = JSON.parse(job.result_json ?? "{}") as JobResult
        await agentModelRepos(async (q) => (await tx.execute(q)).rows).updateJob(jobId, {
          result_json: JSON.stringify({
            ...result,
            attempt_offset: Number(receiptRow.attempt_index),
          }),
        })
      }
      if (turn.status === "running" && turn.started_at === startedAt) return turn
      return (
        await tx.execute(sql`UPDATE job_turn SET status = 'running', started_at = ${startedAt}
        WHERE id = ${turn.id} RETURNING *`)
      ).rows[0] as unknown as JobTurnRecord
    })
  },
  async reserve(input) {
    return db.transaction(async (tx) => {
      const execute = async (q: SQL) => (await tx.execute(q)).rows
      if (!(await capacityAvailable(execute, input.org_id, input.global_limit, input.org_limit)))
        return null
      return agentModelRepos(execute).transitionAgentSandbox(
        input.agent_id,
        input.org_id,
        input.agent_rev,
        { phase: "creating", state_json: input.state_json },
      )
    })
  },
  async borrow(input) {
    return db.transaction(async (tx) => {
      const execute = async (q: SQL) => (await tx.execute(q)).rows
      if (!(await capacityAvailable(execute, input.org_id, input.global_limit, input.org_limit)))
        return null
      const shared = input.agent_rev !== undefined
      if (shared) {
        const agent = (
          await tx.execute(sql`SELECT id FROM agent WHERE id = ${input.agent_id}
          AND org_id = ${input.org_id} AND sandbox_rev = ${input.agent_rev}
          AND sandbox_phase = 'ready' AND paused_at IS NULL FOR UPDATE`)
        ).rows[0]
        if (!agent) return null
      }
      // A parked job resumes its own sandbox; any other job starts from nothing held.
      const from =
        input.phase === "starting" && !shared
          ? sql`machine_phase = 'parked'`
          : sql`(machine_phase IS NULL OR machine_phase = 'released')`
      const held = (
        await tx.execute(sql`UPDATE job SET status = 'running', started_at = ${input.started_at},
        lease_until = ${input.lease_until}, updated_at = ${input.started_at}, machine_phase = ${input.phase},
        machine_json = ${input.machine_json}, machine_rev = machine_rev + 1
        WHERE id = ${input.job_id} AND org_id = ${input.org_id} AND agent_id = ${input.agent_id}
          AND status = 'queued' AND ${from} RETURNING *`)
      ).rows[0] as unknown as JobRecord | undefined
      if (!held) return null
      if (shared)
        await tx.execute(sql`UPDATE agent SET sandbox_phase = 'busy', sandbox_rev = sandbox_rev + 1,
          sandbox_state_json = jsonb_set(coalesce(sandbox_state_json, '{}')::jsonb, '{holder}', to_jsonb(${held.id}::text))::text
          WHERE id = ${input.agent_id} AND org_id = ${input.org_id}`)
      return held
    })
  },
  async compute(jobId, orgId, receipt) {
    return db.transaction(async (tx) => {
      const job = (
        await tx.execute(
          sql`SELECT * FROM job WHERE id = ${jobId} AND org_id = ${orgId} FOR UPDATE`,
        )
      ).rows[0] as unknown as JobRecord | undefined
      if (!job) return null
      const result = JSON.parse(job.result_json ?? "{}") as JobResult
      if (result.compute?.some((r) => r.turn === receipt.turn)) return job
      return agentModelRepos(async (q) => (await tx.execute(q)).rows).updateJob(jobId, {
        result_json: JSON.stringify({ ...result, compute: [...(result.compute ?? []), receipt] }),
      })
    })
  },
  async settle(input) {
    return db.transaction(async (tx) => {
      const job = (
        await tx.execute(sql`SELECT * FROM job WHERE id = ${input.job_id}
        AND org_id = ${input.org_id} FOR UPDATE`)
      ).rows[0] as unknown as JobRecord | undefined
      if (!job) return null
      const turn = (
        await tx.execute(sql`SELECT * FROM job_turn WHERE id = ${input.turn_id}
        AND job_id = ${job.id} AND org_id = ${input.org_id} FOR UPDATE`)
      ).rows[0] as unknown as JobTurnRecord | undefined
      if (!turn) return null
      // A current pre-upgrade claim is valid too. Older claims need their retained row.
      if (turn.started_at === input.started_at)
        await tx.execute(sql`INSERT INTO job_turn_receipt (turn_id, started_at, result_json, reported)
          VALUES (${turn.id}, ${input.started_at}, '{}', 0) ON CONFLICT DO NOTHING`)
      const receipt = await tx.execute(sql`UPDATE job_turn_receipt SET reported = 1,
        result_json = ${input.result_json}, cost_micro_usd = ${input.cost_micro_usd}
        WHERE turn_id = ${turn.id} AND started_at = ${input.started_at} AND reported = 0
        RETURNING turn_id`)
      if (!receipt.rows.length) return { job, settled: false }
      const repos = agentModelRepos(async (s) => (await tx.execute(s)).rows)
      if (input.cost_micro_usd !== null) await repos.addJobCost(job.id, input.cost_micro_usd)
      const previous = JSON.parse(job.result_json ?? "{}") as JobResult
      const next = JSON.parse(input.result_json) as JobResult
      const combined = {
        ...previous,
        ...next,
        attempt_offset: Math.max(
          -1,
          previous.attempt_offset ?? -1,
          ...(previous.runs ?? []).map((r) => r.attempt),
          ...(next.runs ?? []).map((r) => r.attempt),
        ),
        runs: [...(previous.runs ?? []), ...(next.runs ?? [])]
          .sort((a, b) => a.attempt - b.attempt)
          .slice(-600),
      }
      // Late usage is countable; a cancelled attempt cannot reopen the task.
      if (
        job.status !== "running" ||
        job.started_at !== input.started_at ||
        turn.started_at !== input.started_at ||
        turn.status !== "running"
      ) {
        const late = await repos.updateJob(job.id, {
          result_json: JSON.stringify({
            ...previous,
            runs: combined.runs,
            attempt_offset: combined.attempt_offset,
          }),
        })
        return { job: late ?? job, settled: false }
      }
      const now = new Date().toISOString()
      await tx.execute(sql`UPDATE job_turn SET status = ${input.status}, finished_at = ${now},
        body_result_md = ${input.body_md}, result_json = ${input.result_json},
        session_id = ${input.session_id}, checkpoint_enc = ${input.checkpoint_enc} WHERE id = ${turn.id}`)
      if (input.body_md)
        await repos.addJobMessage({
          id: newId("jm"),
          job_id: job.id,
          author_kind: "agent",
          author_id: job.agent_id,
          body_md: input.body_md,
          meta_json: JSON.stringify({ turn_id: turn.id }),
        })
      const waiting =
        (
          await tx.execute(sql`SELECT id FROM job_turn WHERE job_id = ${job.id}
        AND status = 'queued' ORDER BY ordinal LIMIT 1`)
        ).rows.length > 0
      if (input.status === "failed")
        await tx.execute(sql`UPDATE job_turn SET status = 'cancelled', finished_at = ${now}
          WHERE job_id = ${job.id} AND org_id = ${job.org_id} AND status = 'queued'`)
      const status = waiting && input.status === "succeeded" ? "queued" : input.status
      if (input.status !== "failed") delete combined.failure
      let needsJson = input.needs_json
      if (input.status === "needs_you" && job.trigger_id && needsJson) {
        const earlier = (
          await tx.execute(sql`SELECT id, needs_json, result_json, updated_at FROM job
            WHERE org_id = ${job.org_id} AND agent_id = ${job.agent_id}
            AND trigger_id = ${job.trigger_id} AND id <> ${job.id}
            AND status = 'needs_you' ORDER BY id FOR UPDATE`)
        ).rows as unknown as Pick<JobRecord, "id" | "needs_json" | "result_json" | "updated_at">[]
        needsJson = JSON.stringify(questionHistory(JSON.parse(needsJson) as JobNeeds, earlier))
        for (const old of earlier)
          await repos.updateJob(old.id, {
            status: "cancelled",
            finished_at: now,
            lease_until: null,
            dedupe_key: null,
            result_json: JSON.stringify({
              ...JSON.parse(old.result_json ?? "{}"),
              superseded_by: job.id,
            }),
          })
      }
      const updated = await repos.updateJob(job.id, {
        status,
        result_json: JSON.stringify(combined),
        needs_json: needsJson,
        lease_until: null,
        ...(status === "queued"
          ? { started_at: null, finished_at: null, attempt: 0 }
          : { finished_at: now }),
        ...(input.report_artifact_id !== undefined
          ? { report_artifact_id: input.report_artifact_id }
          : {}),
      })
      return updated ? { job: updated, settled: true } : null
    })
  },
})
