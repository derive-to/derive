import {
  type BlobStore,
  type ContextRuntimeRecord,
  type MetaStore,
  newId,
  type RunAttemptRecord,
  type RunAttemptResult,
  type RunRecord,
  type RuntimeRunInput,
} from "@derive/core"
import { type AppDeps, buildContext } from "../context"
import { log } from "../log"
import { afterPublish } from "./after-publish"
import { runtimeRunContext } from "./runtime-access"
import { runtimeController } from "./runtime-controller"
import { runtimeFailureReason } from "./runtime-diagnostics"
import { prepareRuntimeModel } from "./runtime-model-attachment"
import { runtimeModelReady } from "./runtime-model-grant"
import { materializeRuntimeSchedules, runtimeScheduleAllows } from "./runtime-schedule"
import { INSTALL_RUNTIME_RUNNER, reconcileRuntimeSetups } from "./runtime-setup"
import { signRuntimeToken } from "./runtime-token"
import { materializeWorkflowTests } from "./workflow-test"

export interface RuntimeDispatchDeps {
  meta: MetaStore
  blobs: BlobStore
  secret: string
  server: string
  config: NonNullable<AppDeps["runtime"]>
  fetcher?: typeof fetch
  now?: () => Date
  pokeRuntime?: () => void
}
export const RUNTIME_ATTEMPT_MS = 15 * 60_000

async function enabled(
  deps: RuntimeDispatchDeps,
  run: RunRecord,
  runtime: ContextRuntimeRecord,
  claimed = false,
) {
  if (!claimed && !(await runtimeScheduleAllows(deps.meta, run))) return false
  if (!(await runtimeRunContext(deps.meta, deps.config, run, runtime))) return false
  if (runtime.connection_id !== null) return true
  const input = JSON.parse(run.input_snapshot ?? "null") as RuntimeRunInput | null
  return !!input && runtimeModelReady(deps.meta, deps.config, runtime, input.provider, deps.fetcher)
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
  if (["starting", "stopping"].includes(attempt.phase) && !attempt.startup_operation_id) {
    const prepared = await prepareRuntimeModel(deps, run, attempt, runtime)
    if (!prepared) return
    runtime = prepared
  }
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
  const client = await runtimeController(
    deps.meta,
    deps.config,
    deps.secret,
    runtime,
    deps.fetcher,
    attempt.phase === "stopping",
  )
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
          ...(runtime.connection_id === null
            ? ["sh", "-c", `${INSTALL_RUNTIME_RUNNER}\nexec node "$@"`, "derive-runner"]
            : ["node"]),
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
      let runtime = await deps.meta.getContextRuntime(run.runtime_id, run.org_id)
      if (!runtime) continue
      let attempt = await deps.meta.getLatestRunAttempt(run.id, run.org_id)
      if (!attempt) {
        if (!(await enabled(deps, run, runtime))) {
          // A revoked job must not occupy the bounded pending scan indefinitely
          // or silently run later if access is restored.
          await deps.meta.cancelQueuedRuntimeRun(run.id, run.org_id, at.toISOString())
          continue
        }
        await runtimeController(deps.meta, deps.config, deps.secret, runtime, deps.fetcher)
        const now = deps.now?.() ?? new Date()
        attempt = await deps.meta.reserveRunAttempt({
          id: newId("rta"),
          runId: run.id,
          orgId: run.org_id,
          at: now.toISOString(),
          deadlineAt: new Date(now.getTime() + RUNTIME_ATTEMPT_MS).toISOString(),
        })
      }
      // Confirm each durable transition before advancing again. Pending operations,
      // lost responses and unchanged launch intent yield to the recovery sweep.
      const until = performance.now() + 10_000
      for (let step = 0; attempt && step < 8; step++) {
        await reconcile(deps, run, attempt, runtime)
        if (attempt.released_at) break
        const next = await deps.meta.getRunAttempt(attempt.id, run.org_id)
        if (!next || next.revision === attempt.revision || performance.now() >= until) break
        const currentRuntime = await deps.meta.getContextRuntime(run.runtime_id, run.org_id)
        if (!currentRuntime) break
        runtime = currentRuntime
        attempt = next
      }
    } catch (error) {
      // Transport bodies and agent output may contain credentials. IDs suffice for diagnosis.
      log.warn("runtime reconciliation deferred", {
        run: run.id,
        reason: runtimeFailureReason(error),
      })
    }
  }
  await reconcileRuntimeSetups(deps)
  await materializeWorkflowTests(deps)
  // Repair active work before scanning schedules. Admission can wait; shutdown cannot.
  try {
    const admission = await materializeRuntimeSchedules(
      deps.meta,
      at,
      new Set([...deps.config.pilotWorkspaceIds, ...(deps.config.managed?.workspaceIds ?? [])]),
    )
    if (admission.admitted > 0) deps.pokeRuntime?.()
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
