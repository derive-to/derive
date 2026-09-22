import {
  type BlobStore,
  type ContextRuntimeRecord,
  type MetaStore,
  newId,
  type RunAttemptRecord,
  type RunAttemptResult,
  type RunRecord,
} from "@derive/core"
import { type AppDeps, buildContext } from "../context"
import { log } from "../log"
import { afterPublish } from "./after-publish"
import { spendableConnections } from "./broker"
import { decryptSecret } from "./crypto"
import { OrtamClient } from "./ortam-client"
import { runtimeFailureReason } from "./runtime-diagnostics"
import { materializeRuntimeSchedules, runtimeScheduleAllows } from "./runtime-schedule"
import { reconcileRuntimeSetups } from "./runtime-setup"
import { signRuntimeToken } from "./runtime-token"

export interface RuntimeDispatchDeps {
  meta: MetaStore
  blobs: BlobStore
  secret: string
  server: string
  config: NonNullable<AppDeps["runtime"]>
  fetcher?: typeof fetch
  now?: () => Date
}
export const RUNTIME_ATTEMPT_MS = 15 * 60_000

async function runtimeClient(
  deps: RuntimeDispatchDeps,
  runtime: ContextRuntimeRecord,
  cleanup = false,
) {
  if (runtime.api_url !== deps.config.apiUrl)
    throw new Error("Runtime belongs to a different Ortam API")
  const connections = cleanup
    ? await deps.meta.getConnectionsByIds([runtime.connection_id])
    : await spendableConnections(deps.meta, runtime.org_id, [runtime.connection_id])
  const connection = connections.find(
    (c) => c.id === runtime.connection_id && c.org_id === runtime.org_id,
  )
  if (connection?.kind !== "secret" || !connection.secret_enc)
    throw new Error("Ortam connection is unavailable")
  const key = decryptSecret(connection.secret_enc, deps.secret)
  if (key === connection.secret_enc) throw new Error("Ortam connection cannot be decrypted")
  return new OrtamClient(runtime.api_url, key, deps.fetcher)
}

async function enabled(
  deps: RuntimeDispatchDeps,
  run: RunRecord,
  runtime: ContextRuntimeRecord,
  claimed = false,
) {
  if (!claimed && !(await runtimeScheduleAllows(deps.meta, run))) return false
  if (!deps.config.pilotWorkspaceIds.has(run.org_id)) return false
  const settings = await deps.meta.getOrgSettings(run.org_id)
  const context = await deps.meta.getContext(runtime.context_id)
  const agent = await deps.meta.getAgent(run.agent_id)
  const credentials = await spendableConnections(deps.meta, runtime.org_id, [runtime.connection_id])
  return !!(
    credentials.some((c) => c.kind === "secret" && !!c.secret_enc) &&
    (claimed || !run.automation_id || settings.automateBeta) &&
    settings.hostedAgentsEnabled &&
    settings.agentWrites &&
    !runtime.disabled_at &&
    context?.org_id === run.org_id &&
    context.agent_id === run.agent_id &&
    agent?.org_id === run.org_id &&
    run.initiated_by &&
    (await deps.meta.isInstanceOperator(run.initiated_by)) &&
    (await deps.meta.getMembership(run.org_id, run.initiated_by))
  )
}

async function finish(
  deps: RuntimeDispatchDeps,
  run: RunRecord,
  attempt: RunAttemptRecord,
  at: string,
) {
  const result = attempt.result_json ? (JSON.parse(attempt.result_json) as RunAttemptResult) : null
  let report: string | null = null
  if (result) {
    const bytes = new TextEncoder().encode(result.summary)
    const blob = await deps.blobs.put(bytes)
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(attempt.id))
    report = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 8)
    await deps.meta.publishRuntimeReport(attempt.id, run.org_id, report, blob, bytes.length, at)
    const artifact = await deps.meta.getByShortId(report)
    const version = artifact ? await deps.meta.getVersion(artifact.id, 1) : null
    if (!artifact || !version) throw new Error("Report projection is incomplete")
    const ctx = buildContext({ meta: deps.meta, blobs: deps.blobs, baseUrl: deps.server })
    await afterPublish({ ...ctx, baseUrl: deps.server }, artifact, version, {
      isNew: true,
      onBehalf: run.initiated_by,
      actorId: run.agent_id,
      preparedSource: result.summary,
    })
  }
  const succeeded =
    result && ["completed", "completed_with_gaps", "no_change"].includes(result.outcome)
  await deps.meta.settleRuntimeRun(
    run.id,
    run.org_id,
    attempt.id,
    succeeded ? "succeeded" : "failed",
    JSON.stringify({
      runtime: {
        attempt_id: attempt.id,
        outcome: result?.outcome ?? "unknown",
        report_short_id: report,
        save_status: attempt.save_status,
        released_at: attempt.released_at,
      },
    }),
    at,
  )
}

async function reconcile(
  deps: RuntimeDispatchDeps,
  run: RunRecord,
  attempt: RunAttemptRecord,
  runtime: ContextRuntimeRecord,
) {
  const at = (deps.now?.() ?? new Date()).toISOString()
  if (attempt.released_at) return finish(deps, run, attempt, at)
  await deps.meta.markRuntimeRunStarted(run.id, run.org_id, at)
  const identity = { organization_id: runtime.ortam_org_id, user_id: runtime.ortam_user_id }
  const transition = (change: Parameters<MetaStore["transitionRunAttempt"]>[3]) =>
    deps.meta.transitionRunAttempt(attempt.id, run.org_id, attempt.revision, change, at)
  if (
    attempt.phase !== "stopping" &&
    (attempt.result_json ||
      at >= attempt.deadline_at ||
      !(await enabled(deps, run, runtime, !!attempt.runner_claimed_at)))
  ) {
    await transition({ phase: "stopping" })
    return
  }
  const client = await runtimeClient(deps, runtime, attempt.phase === "stopping")
  if (attempt.phase === "starting") {
    if (!attempt.startup_operation_id) {
      const operation = await client.lifecycle(
        runtime.sandbox_id,
        "resume",
        `derive-${attempt.id}-resume`,
        identity,
      )
      await transition({ phase: "starting", startup_operation_id: operation.id })
    } else {
      const op = await client.operation(
        attempt.startup_operation_id,
        runtime.sandbox_id,
        "resume",
        identity,
      )
      if (op.state === "succeeded") await transition({ phase: "ready" })
      if (op.state === "failed") await transition({ phase: "stopping" })
    }
  } else if (attempt.phase === "ready") {
    const sandbox = await client.sandbox(runtime.sandbox_id, identity)
    if (
      sandbox.state !== "ready" ||
      sandbox.agent_connections?.user_id !== runtime.ortam_user_id ||
      sandbox.auto_stop_after_seconds <= 0 ||
      sandbox.auto_stop_after_seconds > 1200
    ) {
      await transition({ phase: "stopping" })
      return
    }
    const launching = await transition({ phase: "launching" })
    if (!launching) return
    // Exactly the CAS winner submits. A lost response leaves launching until its deadline;
    // another controller must never repeat a non-idempotent process request.
    const token = await signRuntimeToken(
      deps.secret,
      attempt.id,
      run.org_id,
      Date.parse(attempt.deadline_at) + 300_000,
    )
    const process = await client.launch(
      runtime.sandbox_id,
      {
        argv: [
          "node",
          deps.config.runnerPath,
          "runner",
          "run",
          "--model-auth",
          "ortam",
          "--cwd",
          "/home/ortam/work",
        ],
        cwd: "/home/ortam",
        env: {
          DERIVE_TOKEN: token,
          DERIVE_SERVER: deps.server,
          DERIVE_ATTEMPT_ID: attempt.id,
          DERIVE_RUNNER_ISOLATED: "1",
        },
        timeout_seconds: Math.max(
          1,
          Math.ceil((Date.parse(attempt.deadline_at) - Date.parse(at)) / 1000),
        ),
      },
      identity,
    )
    const current = await deps.meta.getRunAttempt(attempt.id, run.org_id)
    if (current && !current.released_at)
      await deps.meta.transitionRunAttempt(
        current.id,
        run.org_id,
        current.revision,
        { phase: current.phase === "stopping" ? "stopping" : "running", process_id: process.id },
        (deps.now?.() ?? new Date()).toISOString(),
      )
  } else if (attempt.phase === "running" && attempt.process_id) {
    const process = await client.process(runtime.sandbox_id, attempt.process_id, identity)
    if (!["starting", "running"].includes(process.status)) await transition({ phase: "stopping" })
  } else if (attempt.phase === "stopping") {
    // Auto-stop or an operator may have stopped it before our request. Ortam only
    // reports stopped once compute is absent and developer state is committed.
    const observed = await client.sandbox(runtime.sandbox_id, identity)
    if (observed.state === "stopped") {
      await deps.meta.releaseRunAttempt(
        attempt.id,
        run.org_id,
        attempt.revision,
        { status: "saved", snapshotId: null },
        at,
      )
      return
    }
    if (!attempt.stop_operation_id) {
      const op = await client.lifecycle(
        runtime.sandbox_id,
        "stop",
        `derive-${attempt.id}-stop`,
        identity,
      )
      await transition({ phase: "stopping", stop_operation_id: op.id })
    } else {
      const op = await client.operation(
        attempt.stop_operation_id,
        runtime.sandbox_id,
        "stop",
        identity,
      )
      // A failed operation alone does not prove compute is gone. Keep ownership for repair.
      if (op.state !== "succeeded") return
      const sandbox = await client.sandbox(runtime.sandbox_id, identity)
      if (sandbox.state !== "stopped") return
      await deps.meta.releaseRunAttempt(
        attempt.id,
        run.org_id,
        attempt.revision,
        { status: "saved", snapshotId: null },
        at,
      )
    }
  }
}

/** Each pass advances durable work. Cleanup is never rollout-gated. */
export async function runtimeDispatchPass(deps: RuntimeDispatchDeps) {
  const at = deps.now?.() ?? new Date()
  log.info("runtime dispatch started", {
    at: at.toISOString(),
    pilot_workspaces: deps.config.pilotWorkspaceIds.size,
  })
  const pending = await deps.meta.listPendingRuntimeRuns(100)
  const cleanup = await deps.meta.listUnreleasedRunAttempts(100)
  const runs = new Map(pending.map((run) => [run.id, run]))
  for (const attempt of cleanup) {
    const run = await deps.meta.getRun(attempt.run_id)
    if (run) runs.set(run.id, run)
  }
  for (const run of runs.values()) {
    try {
      if (!run.runtime_id) continue
      const runtime = await deps.meta.getContextRuntime(run.runtime_id, run.org_id)
      if (!runtime) continue
      let attempt = await deps.meta.getLatestRunAttempt(run.id, run.org_id)
      if (!attempt) {
        if (!(await enabled(deps, run, runtime))) {
          // A revoked job must not occupy the bounded pending scan indefinitely
          // or silently run later if access is restored.
          await deps.meta.cancelQueuedRuntimeRun(run.id, run.org_id, at.toISOString())
          continue
        }
        await runtimeClient(deps, runtime)
        const now = deps.now?.() ?? new Date()
        attempt = await deps.meta.reserveRunAttempt({
          id: newId("rta"),
          runId: run.id,
          orgId: run.org_id,
          at: now.toISOString(),
          deadlineAt: new Date(now.getTime() + RUNTIME_ATTEMPT_MS).toISOString(),
        })
      }
      if (attempt) await reconcile(deps, run, attempt, runtime)
    } catch (error) {
      // Transport bodies and agent output may contain credentials. IDs suffice for diagnosis.
      log.warn("runtime reconciliation deferred", {
        run: run.id,
        reason: runtimeFailureReason(error),
      })
    }
  }
  await reconcileRuntimeSetups(deps)
  // Repair active work before scanning schedules. Admission can wait; shutdown cannot.
  try {
    const admission = await materializeRuntimeSchedules(
      deps.meta,
      at,
      deps.config.pilotWorkspaceIds,
    )
    log.info("runtime dispatch completed", {
      pending: pending.length,
      unreleased: cleanup.length,
      ...admission,
    })
  } catch (error) {
    log.warn("runtime schedule pass failed", { reason: runtimeFailureReason(error) })
    throw error
  }
}
