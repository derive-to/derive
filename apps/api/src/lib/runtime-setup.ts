import type { MetaStore, RuntimeSetupRecord } from "@derive/core"
import type { AppDeps } from "../context"
import { log } from "../log"
import { spendableConnections } from "./broker"
import { runtimeController } from "./runtime-controller"
import { runtimeFailureReason } from "./runtime-diagnostics"
import { runtimeModelSelection } from "./runtime-model-grant"

interface SetupDeps {
  meta: MetaStore
  secret: string
  config: NonNullable<AppDeps["runtime"]>
  fetcher?: typeof fetch
  now?: () => Date
}

export const RUNNER_VERSION = "0.7.2"
const RUNNER_DIRECTORY = `/home/ortam/derive-runtime/${RUNNER_VERSION}`
export const SETUP_RUNNER_PATH = `${RUNNER_DIRECTORY}/node_modules/@derive-to/cli/bin/derive.js`

/** Install once per saved environment, then atomically expose a complete runner. */
export const INSTALL_RUNTIME_RUNNER = [
  "set -eu",
  "mkdir -p /home/ortam/derive-runtime /home/ortam/work",
  `if [ ! -f ${RUNNER_DIRECTORY}/.ready ]; then`,
  `  test ! -e ${RUNNER_DIRECTORY}`, // Never overwrite an unknown or incomplete installation.
  `  stage=$(mktemp -d /home/ortam/derive-runtime/.install-${RUNNER_VERSION}-XXXXXX)`,
  `  trap 'rm -rf "$stage"' EXIT`,
  `  npm install --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund --save-exact @derive-to/cli@${RUNNER_VERSION}`,
  `  node "$stage/node_modules/@derive-to/cli/bin/derive.js" --help >/dev/null`,
  `  touch "$stage/.ready"`,
  `  mv "$stage" ${RUNNER_DIRECTORY}`,
  "  trap - EXIT",
  "fi",
].join("\n")
export const SETUP_TIMEOUT_MS = 30 * 60_000

/** This exact request is persisted before submission, including the version, for replay across deploys. */
export function runtimeSetupRequest(id: string) {
  return {
    name: `derive-${id.replaceAll("_", "-")}`,
    size: "small",
    auto_stop_after_seconds: 1200,
    setup_script: INSTALL_RUNTIME_RUNNER,
  }
}

async function advance(deps: SetupDeps, setup: RuntimeSetupRecord) {
  const at = (deps.now?.() ?? new Date()).toISOString()
  const { meta } = deps
  const transition = (change: Parameters<typeof meta.transitionRuntimeSetup>[3]) =>
    meta.transitionRuntimeSetup(setup.id, setup.org_id, setup.revision, change, at)
  if (setup.phase === "binding") {
    // Consent and cancellation serialized at admission. The store projects the saved
    // handover, including a crash after insertion but before this receipt was updated.
    if (await meta.bindRuntimeSetup(setup.id, setup.org_id, at))
      await transition({ phase: "ready" })
    return
  }
  const context = await meta.getContext(setup.context_id)
  const settings = await meta.getOrgSettings(setup.org_id)
  const managed = setup.connection_id === null
  const active = setup.connection_id
    ? await spendableConnections(meta, setup.org_id, [setup.connection_id])
    : []
  const selected = setup.model_connection_id
    ? await runtimeModelSelection(meta, setup.context_id, setup.org_id)
    : null
  const allowed =
    !setup.cancelled_at &&
    (!setup.model_connection_id ||
      (selected?.connection.id === setup.model_connection_id &&
        selected.binding.revision === setup.model_binding_revision)) &&
    at < setup.deadline_at &&
    (managed
      ? deps.config.managed?.workspaceIds.has(setup.org_id)
      : deps.config.pilotWorkspaceIds.has(setup.org_id)) &&
    settings.hostedAgentsEnabled &&
    settings.agentWrites &&
    context?.org_id === setup.org_id &&
    context.agent_id === setup.agent_id &&
    (managed || (await meta.isInstanceOperator(setup.created_by))) &&
    (await meta.getMembership(setup.org_id, setup.created_by)) &&
    (managed || active.some((c) => c.kind === "secret" && !!c.secret_enc))
  if (setup.phase === "queued") {
    await transition({ phase: allowed ? "creating" : "failed" })
    return
  }
  const client = await runtimeController(meta, deps.config, deps.secret, setup, deps.fetcher, true)
  const identity = { organization_id: setup.ortam_org_id, user_id: setup.ortam_user_id }
  if (setup.phase === "creating") {
    // Even after cancellation, resolve an ambiguous accepted create with the SAME immutable request/key.
    const result = await client.create(
      JSON.parse(setup.request_json),
      `derive-${setup.id}-create`,
      identity,
    )
    await transition({
      phase: "provisioning",
      sandbox_id: result.sandbox.id,
      create_operation_id: result.operation.id,
    })
    return
  }
  if (!setup.sandbox_id || !setup.create_operation_id)
    throw new Error("Runtime setup receipt is incomplete")
  if (setup.phase === "provisioning") {
    const op = await client.operation(
      setup.create_operation_id,
      setup.sandbox_id,
      "create",
      identity,
    )
    // Never race an in-flight create with deletion, including after a lost response or timeout.
    if (op.state === "succeeded" || op.state === "failed")
      await transition({ phase: op.state === "succeeded" && allowed ? "stopping" : "deleting" })
    return
  }
  if (setup.phase !== "deleting" && !allowed) {
    await transition({ phase: "deleting" })
    return
  }
  if (setup.phase === "deleting") {
    if (!setup.delete_operation_id) {
      if (await client.isSandboxDeleted(setup.sandbox_id, identity)) {
        await transition({ phase: "failed" })
        return
      }
      const op = await client.deleteSandbox(setup.sandbox_id, `derive-${setup.id}-delete`, identity)
      await transition({ phase: "deleting", delete_operation_id: op.id })
    } else {
      const op = await client.operation(
        setup.delete_operation_id,
        setup.sandbox_id,
        "delete",
        identity,
      )
      // Ortam can finish background cleanup after the original operation fails.
      // Keep ownership until either the operation or the sandbox confirms deletion.
      if (
        op.state === "succeeded" ||
        (op.state === "failed" && (await client.isSandboxDeleted(setup.sandbox_id, identity)))
      )
        await transition({ phase: "failed" })
    }
    return
  }
  const sandbox = await client.sandbox(setup.sandbox_id, identity)
  if (setup.phase === "stopping") {
    if (sandbox.state === "stopped") {
      await transition({ phase: "awaiting_connection" })
    } else if (!setup.stop_operation_id) {
      const op = await client.lifecycle(
        setup.sandbox_id,
        "stop",
        `derive-${setup.id}-stop`,
        identity,
      )
      await transition({ phase: "stopping", stop_operation_id: op.id })
    } else {
      const op = await client.operation(setup.stop_operation_id, setup.sandbox_id, "stop", identity)
      if (op.state === "failed") await transition({ phase: "deleting" })
    }
    return
  }
  if (setup.phase === "awaiting_connection") {
    if (sandbox.state !== "stopped" || sandbox.agent_connections?.user_id !== setup.ortam_user_id)
      return
    if (
      sandbox.auto_stop_after_seconds <= 0 ||
      sandbox.auto_stop_after_seconds > 1200 ||
      deps.config.runnerPath !== SETUP_RUNNER_PATH
    ) {
      await transition({ phase: "deleting" })
      return
    }
    await transition({ phase: "binding" })
    // The next step confirms the binding. A concurrent cancellation is enforced by the store.
  }
}

export async function reconcileRuntimeSetups(deps: SetupDeps) {
  for (let setup of await deps.meta.listPendingRuntimeSetups(100)) {
    try {
      // Drain confirmed progress, not an external operation that is still pending.
      // Reload consent and revision before each step; cron recovers a lost wake-up.
      const until = performance.now() + 10_000
      for (let step = 0; step < 8; step++) {
        await advance(deps, setup)
        const next = await deps.meta.getRuntimeSetup(setup.context_id, setup.org_id)
        if (
          !next ||
          next.id !== setup.id ||
          next.revision === setup.revision ||
          ["ready", "failed"].includes(next.phase) ||
          performance.now() >= until
        )
          break
        setup = next
      }
    } catch (error) {
      log.warn("runtime setup deferred", {
        setup: setup.id,
        phase: setup.phase,
        reason: runtimeFailureReason(error),
      })
    }
  }
}
