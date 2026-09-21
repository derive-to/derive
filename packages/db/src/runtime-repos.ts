import type {
  ContextRuntimeRecord,
  NewRun,
  RunAttemptPhase,
  RunAttemptRecord,
  RunAttemptResult,
  RunRecord,
  RuntimeRunInput,
  RuntimeStore,
} from "@derive/core"
import { CONTEXT_ENVIRONMENT_LIMIT, contextEnvironmentNameError } from "@derive/core"
import { type SQL, sql } from "drizzle-orm"

const instant = (value: string): string => {
  if (new Date(value).toISOString() !== value) throw new Error("Expected a canonical UTC timestamp")
  return value
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0

const TRANSITIONS: Record<RunAttemptPhase, readonly RunAttemptPhase[]> = {
  starting: ["starting", "ready", "stopping"],
  ready: ["launching", "stopping"],
  launching: ["running", "stopping"],
  running: ["stopping"],
  stopping: ["stopping"],
  released: [],
}

/** Decode once at admission, including when a caller bypasses the HTTP schema. */
const checkedInput = (value: string | null | undefined): RuntimeRunInput => {
  const input = JSON.parse(value ?? "null") as RuntimeRunInput | null
  if (
    input?.version !== 1 ||
    !text(input.instruction) ||
    !text(input.context_id) ||
    !text(input.manifest?.artifact_id) ||
    !text(input.manifest?.blob_key) ||
    !Number.isSafeInteger(input.manifest.version) ||
    input.manifest.version < 1 ||
    !["claude-code", "codex"].includes(input.provider) ||
    !(input.model === null || text(input.model)) ||
    !Array.isArray(input.connection_ids) ||
    !input.connection_ids.every(text) ||
    !input.environment_bindings ||
    Array.isArray(input.environment_bindings) ||
    typeof input.environment_bindings !== "object" ||
    Object.keys(input.environment_bindings).length > CONTEXT_ENVIRONMENT_LIMIT ||
    !Object.entries(input.environment_bindings).every(
      ([name, id]) => !contextEnvironmentNameError(name) && text(id),
    )
  )
    throw new Error("Invalid runtime run input snapshot")
  // Copy the accepted shape; accidental caller fields must not turn this into secret storage.
  return {
    version: 1,
    instruction: input.instruction,
    context_id: input.context_id,
    manifest: {
      artifact_id: input.manifest.artifact_id,
      version: input.manifest.version,
      blob_key: input.manifest.blob_key,
    },
    provider: input.provider,
    model: input.model,
    connection_ids: [...input.connection_ids],
    environment_bindings: { ...input.environment_bindings },
  }
}

const resultJson = (result: RunAttemptResult): string => {
  if (
    result.version !== 1 ||
    ![
      "completed",
      "completed_with_gaps",
      "no_change",
      "needs_input",
      "failed",
      "cancelled",
    ].includes(result.outcome) ||
    !text(result.summary) ||
    result.summary.length > 16000 ||
    !Array.isArray(result.outputs) ||
    result.outputs.length > 100 ||
    !result.outputs.every(
      (o) =>
        o.kind === "artifact" &&
        text(o.short_id) &&
        Number.isSafeInteger(o.version) &&
        o.version > 0,
    )
  )
    throw new Error("Invalid attempt result")
  // Fixed field order makes a replay independent of the caller's object property order.
  return JSON.stringify({
    version: 1,
    outcome: result.outcome,
    summary: result.summary,
    outputs: result.outputs.map((o) => ({
      kind: o.kind,
      short_id: o.short_id,
      version: o.version,
    })),
  })
}

/** Single-statement mutations work on D1 as well as SQLite and Postgres. Unique partial
 * indexes own exclusion; no read-then-write lock and no process-local lease grants authority. */
export function runtimeRepos(execute: (statement: SQL) => Promise<unknown[]>): RuntimeStore & {
  createRuntimeRun(input: NewRun): Promise<RunRecord>
} {
  const rows = async <T>(statement: SQL): Promise<T[]> => (await execute(statement)) as T[]
  const first = async <T>(statement: SQL): Promise<T | null> =>
    (await rows<T>(statement))[0] ?? null
  const getRunAttempt: RuntimeStore["getRunAttempt"] = (id, orgId) =>
    first<RunAttemptRecord>(sql`SELECT * FROM run_attempt WHERE id = ${id} AND org_id = ${orgId}`)
  return {
    claimRunAttempt: (id, orgId, at) =>
      first<RunAttemptRecord>(sql`
      UPDATE run_attempt SET runner_claimed_at = ${instant(at)}, revision = revision + 1, updated_at = ${at}
      WHERE id = ${id} AND org_id = ${orgId} AND phase IN ('launching', 'running')
        AND deadline_at > ${at} AND runner_claimed_at IS NULL AND result_json IS NULL AND released_at IS NULL RETURNING *`),
    getContextRuntimeForContext: (contextId, orgId) =>
      first<ContextRuntimeRecord>(
        sql`SELECT * FROM context_runtime WHERE context_id = ${contextId} AND org_id = ${orgId}`,
      ),
    listPendingRuntimeRuns: (limit = 100) =>
      rows<RunRecord>(sql`
      SELECT * FROM run WHERE runtime_id IS NOT NULL AND status IN ('queued', 'running')
      ORDER BY created_at, id LIMIT ${Math.max(1, Math.min(1000, limit))}`),
    getLatestRunAttempt: (runId, orgId) =>
      first<RunAttemptRecord>(sql`
      SELECT * FROM run_attempt WHERE run_id = ${runId} AND org_id = ${orgId} ORDER BY attempt DESC LIMIT 1`),
    async markRuntimeRunStarted(runId, orgId, at) {
      await execute(sql`UPDATE run SET status = 'running', started_at = coalesce(started_at, ${instant(at)})
        WHERE id = ${runId} AND org_id = ${orgId} AND runtime_id IS NOT NULL AND status = 'queued'
          AND EXISTS (SELECT 1 FROM run_attempt a WHERE a.run_id = run.id AND a.released_at IS NULL) RETURNING id`)
    },
    async settleRuntimeRun(runId, orgId, attemptId, status, meta, at) {
      await execute(sql`UPDATE run SET status = ${status}, meta = ${meta}, finished_at = ${instant(at)}
        WHERE id = ${runId} AND org_id = ${orgId} AND runtime_id IS NOT NULL AND status IN ('queued', 'running')
          AND EXISTS (SELECT 1 FROM run_attempt a WHERE a.id = ${attemptId} AND a.run_id = run.id AND a.released_at IS NOT NULL
            AND a.attempt = (SELECT max(latest.attempt) FROM run_attempt latest WHERE latest.run_id = run.id))
          AND NOT EXISTS (SELECT 1 FROM run_attempt a WHERE a.run_id = run.id AND a.released_at IS NULL) RETURNING id`)
    },
    async publishRuntimeReport(attemptId, orgId, shortId, blobKey, sizeBytes, at) {
      const artifactId = `runtime-report-${attemptId}`
      // Each statement repairs its own interrupted predecessor. IDs are stable and the
      // projection becomes visible only after the immutable version is present.
      await execute(sql`INSERT INTO artifact (id, short_id, org_id, title, kind, spa, workspace_access, link_role, listed)
        SELECT ${artifactId}, ${shortId}, r.org_id, 'Agent run report', 'file', 0, 'none', 'none', 'none'
        FROM run_attempt a JOIN run r ON r.id = a.run_id AND r.org_id = a.org_id
        WHERE a.id = ${attemptId} AND a.org_id = ${orgId} AND a.result_json IS NOT NULL AND r.initiated_by IS NOT NULL
        ON CONFLICT DO NOTHING RETURNING id`)
      const artifact = await first<{ id: string }>(
        sql`SELECT id FROM artifact WHERE short_id = ${shortId} AND id = ${artifactId} AND org_id = ${orgId}`,
      )
      if (!artifact) throw new Error("Report identity is unavailable")
      await execute(sql`INSERT INTO version (id, artifact_id, n, blob_key, content_type, size_bytes, author, author_id, agent_id, source)
        SELECT ${artifactId}, ${artifactId}, 1, ${blobKey}, 'text/markdown', ${sizeBytes}, 'Agent', r.initiated_by, r.agent_id, 'api'
        FROM run_attempt a JOIN run r ON r.id = a.run_id WHERE a.id = ${attemptId} AND a.org_id = ${orgId}
        ON CONFLICT DO NOTHING RETURNING id`)
      const stored = await first<{ blob_key: string }>(
        sql`SELECT blob_key FROM version WHERE id = ${artifactId}`,
      )
      if (stored?.blob_key !== blobKey)
        throw new Error("Report content differs from the saved receipt")
      await execute(sql`INSERT INTO artifact_member (id, artifact_id, user_id, role)
        SELECT ${artifactId}, ${artifactId}, r.initiated_by, 'owner'
        FROM run_attempt a JOIN run r ON r.id = a.run_id WHERE a.id = ${attemptId} AND a.org_id = ${orgId}
        ON CONFLICT DO NOTHING RETURNING id`)
      await execute(sql`UPDATE artifact SET current_version = 1, current_content_type = 'text/markdown', author_name = 'Agent',
        author_id = (SELECT r.initiated_by FROM run r JOIN run_attempt a ON a.run_id = r.id WHERE a.id = ${attemptId}), updated_at = ${instant(at)}
        WHERE id = ${artifactId} AND current_version = 0 RETURNING id`)
    },
    async createContextRuntime(input, at) {
      instant(at)
      const url = new URL(input.api_url)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw new Error("Runtime API must be HTTPS or local HTTP, without URL credentials")
      if (!Object.values(input).every(text)) throw new Error("Runtime binding fields are required")
      const apiUrl = url.toString().replace(/\/+$/, "")
      return first<ContextRuntimeRecord>(sql`
        INSERT INTO context_runtime (id, org_id, context_id, agent_id, api_url, ortam_org_id,
          ortam_user_id, sandbox_id, connection_id, created_at)
        SELECT ${input.id}, ${input.org_id}, c.id, c.agent_id, ${apiUrl}, ${input.ortam_org_id},
          ${input.ortam_user_id}, ${input.sandbox_id}, cn.id, ${at}
        FROM context c JOIN connection cn ON cn.id = ${input.connection_id} AND cn.org_id = c.org_id
        WHERE c.id = ${input.context_id} AND c.org_id = ${input.org_id}
          AND c.agent_id = ${input.agent_id} AND c.import_source IS NULL
          AND cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL
        ON CONFLICT DO NOTHING RETURNING *`)
    },
    getContextRuntime: (id, orgId) =>
      first<ContextRuntimeRecord>(
        sql`SELECT * FROM context_runtime WHERE id = ${id} AND org_id = ${orgId}`,
      ),
    async disableContextRuntime(id, orgId, at) {
      await execute(sql`UPDATE context_runtime SET disabled_at = ${instant(at)}
        WHERE id = ${id} AND org_id = ${orgId} AND disabled_at IS NULL RETURNING id`)
      await execute(sql`UPDATE run SET status = 'failed', finished_at = ${at}
        WHERE runtime_id = ${id} AND org_id = ${orgId} AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM run_attempt a WHERE a.run_id = run.id) RETURNING id`)
    },
    async createRuntimeRun(input) {
      const snapshot = checkedInput(input.input_snapshot)
      if (
        !input.runtime_id ||
        (input.status && input.status !== "queued") ||
        input.started_at ||
        input.finished_at
      )
        throw new Error("Runtime runs must enter the queue before execution")
      const row = await first<RunRecord>(sql`
        INSERT INTO run (id, org_id, automation_id, agent_id, reason, initiated_by, status,
          scheduled_for, runtime_id, input_snapshot, meta, created_at)
        SELECT ${input.id}, rt.org_id, ${input.automation_id ?? null}, rt.agent_id, ${input.reason},
          ${input.initiated_by ?? null}, 'queued', ${input.scheduled_for ?? null}, rt.id,
          ${JSON.stringify(snapshot)}, ${input.meta ?? null}, ${new Date().toISOString()}
        FROM context_runtime rt JOIN context c ON c.id = rt.context_id AND c.org_id = rt.org_id
        JOIN connection cn ON cn.id = rt.connection_id AND cn.org_id = rt.org_id
        JOIN version v ON v.artifact_id = c.manifest_artifact_id
        WHERE rt.id = ${input.runtime_id} AND rt.org_id = ${input.org_id}
          AND rt.agent_id = ${input.agent_id} AND c.agent_id = rt.agent_id AND rt.disabled_at IS NULL
          AND cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL
          AND (cast(${input.automation_id ?? null} AS text) IS NULL OR EXISTS (
            SELECT 1 FROM automation a WHERE a.id = ${input.automation_id ?? null}
              AND a.org_id = rt.org_id AND a.agent_id = rt.agent_id
              AND a.context_id = c.id AND a.enabled = 1))
          AND c.id = ${snapshot.context_id} AND v.artifact_id = ${snapshot.manifest.artifact_id}
          AND v.n = ${snapshot.manifest.version} AND v.blob_key = ${snapshot.manifest.blob_key}
        RETURNING *`)
      if (!row) throw new Error("Runtime or pinned Context is unavailable to this run")
      return row
    },
    async reserveRunAttempt(input) {
      instant(input.at)
      instant(input.deadlineAt)
      if (input.deadlineAt <= input.at) throw new Error("Attempt deadline must follow admission")
      return first<RunAttemptRecord>(sql`
        INSERT INTO run_attempt (id, org_id, run_id, runtime_id, attempt, phase, deadline_at, created_at, updated_at)
        SELECT ${input.id}, r.org_id, r.id, rt.id,
          (SELECT coalesce(max(a.attempt), 0) + 1 FROM run_attempt a WHERE a.run_id = r.id),
          'starting', ${input.deadlineAt}, ${input.at}, ${input.at}
        FROM run r JOIN context_runtime rt ON rt.id = r.runtime_id AND rt.org_id = r.org_id
        JOIN context c ON c.id = rt.context_id AND c.org_id = rt.org_id
        JOIN connection cn ON cn.id = rt.connection_id AND cn.org_id = rt.org_id
        WHERE r.id = ${input.runId} AND r.org_id = ${input.orgId} AND r.status = 'queued'
          AND (r.scheduled_for IS NULL OR r.scheduled_for <= ${input.at})
          AND rt.disabled_at IS NULL AND c.agent_id = rt.agent_id AND r.agent_id = rt.agent_id
          AND cn.kind = 'secret' AND cn.status = 'active' AND cn.secret_enc IS NOT NULL
          AND (r.automation_id IS NULL OR EXISTS (
            SELECT 1 FROM automation a WHERE a.id = r.automation_id AND a.org_id = r.org_id
              AND a.agent_id = r.agent_id AND a.context_id = c.id AND a.enabled = 1))
          AND NOT EXISTS (SELECT 1 FROM run_attempt a WHERE a.run_id = r.id
            AND (a.result_json IS NOT NULL OR a.launch_started_at IS NOT NULL))
        ON CONFLICT DO NOTHING RETURNING *`)
    },
    getRunAttempt,
    listUnreleasedRunAttempts: (limit = 100) =>
      rows<RunAttemptRecord>(sql`
      SELECT * FROM run_attempt WHERE released_at IS NULL ORDER BY updated_at, id LIMIT ${Math.max(1, Math.min(1000, limit))}`),
    async transitionRunAttempt(id, orgId, revision, change, at) {
      instant(at)
      const prior = await getRunAttempt(id, orgId)
      if (!prior || prior.revision !== revision || prior.released_at) return null
      if (!TRANSITIONS[prior.phase].includes(change.phase)) return null
      // An expired owner still has to record receipts and stop its sandbox. It must
      // not advance toward execution. Late start/process receipts belong on stopping.
      if (at >= prior.deadline_at && change.phase !== "stopping") return null
      if (
        (change.startup_operation_id !== undefined &&
          prior.phase !== "starting" &&
          change.phase !== "stopping") ||
        (change.process_id !== undefined &&
          prior.phase !== "launching" &&
          change.phase !== "stopping") ||
        (change.stop_operation_id !== undefined && change.phase !== "stopping")
      )
        return null
      for (const key of ["startup_operation_id", "process_id", "stop_operation_id"] as const) {
        if (
          change[key] !== undefined &&
          (!text(change[key]) || (prior[key] && prior[key] !== change[key]))
        )
          return null
      }
      const process = change.process_id ?? prior.process_id
      if (change.phase === "running" && !process) return null
      return first<RunAttemptRecord>(sql`UPDATE run_attempt SET phase = ${change.phase},
        startup_operation_id = ${change.startup_operation_id ?? prior.startup_operation_id},
        launch_started_at = ${change.phase === "launching" ? at : prior.launch_started_at},
        process_id = ${process}, stop_operation_id = ${change.stop_operation_id ?? prior.stop_operation_id},
        updated_at = ${at}, revision = revision + 1
        WHERE id = ${id} AND org_id = ${orgId} AND revision = ${revision} AND released_at IS NULL RETURNING *`)
    },
    async acceptRunAttemptResult(id, orgId, result, at) {
      const json = resultJson(result)
      const row = await first<RunAttemptRecord>(sql`UPDATE run_attempt SET result_json = ${json},
        updated_at = ${instant(at)}, revision = revision + 1
        WHERE id = ${id} AND org_id = ${orgId} AND phase IN ('launching', 'running') AND result_json IS NULL
          AND deadline_at > ${at} AND released_at IS NULL RETURNING *`)
      if (row) return row
      const prior = await getRunAttempt(id, orgId)
      return prior?.result_json === json ? prior : null
    },
    async releaseRunAttempt(id, orgId, revision, save, at) {
      if (
        !(save.status === "saved" || save.status === "failed") ||
        (save.status === "saved" && save.snapshotId !== null && !text(save.snapshotId)) ||
        (save.status === "failed" && save.snapshotId !== null)
      )
        throw new Error("Invalid stop receipt")
      return first<RunAttemptRecord>(sql`UPDATE run_attempt SET phase = 'released',
        save_status = ${save.status}, saved_snapshot_id = ${save.snapshotId}, released_at = ${instant(at)},
        updated_at = ${at}, revision = revision + 1
        WHERE id = ${id} AND org_id = ${orgId} AND revision = ${revision} AND phase = 'stopping'
          AND released_at IS NULL RETURNING *`)
    },
  }
}
