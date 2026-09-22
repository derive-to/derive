#!/usr/bin/env node
// Disposable, opt-in qualification of Ortam's public lifecycle API. This is not
// the hosted-run dispatcher. Keep its receipt until cleanup is confirmed.
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

const REQUEST_MS = 15_000
const PROBE_MS = 15 * 60_000
const CLEANUP_MS = 15 * 60_000
class CleanupUnconfirmed extends Error {}

const phases = ["create", "ready", "launch", "observe", "stop", "delete", "done"]

function apiBase(value) {
  const url = new URL(value)
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== "/v1"
  )
    throw new Error("ORTAM_API_URL must be an HTTPS /v1 URL (HTTP is allowed only on loopback)")
  return url.href.replace(/\/$/, "")
}

// Never include response bodies or request headers in errors: a proxy may echo
// credentials. The receipt carries only this probe's fixed command output.
async function json(fetcher, url, init) {
  let response
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    })
  } catch {
    throw new Error("Ortam request did not complete; its outcome may be unknown")
  }
  if (!response.ok) throw new Error(`Ortam returned HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error("Ortam returned invalid JSON")
  }
}

function client(apiUrl, apiKey, fetcher) {
  let token
  let organization
  const authenticate = async () => {
    const body = await json(fetcher, `${apiUrl}/auth/token`, { headers: { "X-API-Key": apiKey } })
    let claims
    try {
      claims = JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString())
    } catch {
      throw new Error("Ortam did not return a usable access token")
    }
    if (typeof claims.organization_id !== "string" || !claims.organization_id)
      throw new Error("Ortam access token has no organization")
    if (organization && organization !== claims.organization_id)
      throw new Error("Ortam credentials changed organization during the check")
    organization = claims.organization_id
    token = body.token
    return organization
  }
  return {
    authenticate,
    async request(path, method = "GET", body, key, headers = {}) {
      // Refresh before each step. No implicit retries, especially for process start.
      await authenticate()
      return json(fetcher, `${apiUrl}${path}`, {
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  }
}

async function writeReceipt(path, value) {
  const temporary = `${path}.tmp`
  const file = await open(temporary, "w", 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  const directory = await open(dirname(path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function validateReceipt(state, apiUrl, organization) {
  if (
    state?.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(state.id ?? "") ||
    !phases.includes(state.phase) ||
    state.api_url !== apiUrl ||
    state.organization !== organization ||
    !Number.isFinite(Date.parse(state.created_at)) ||
    (state.phase !== "create" && (!state.sandbox_id || !state.create_operation)) ||
    (state.phase === "observe" && !state.process_id) ||
    (state.phase === "done" &&
      (!state.delete_operation ||
        state.cleanup_confirmed !== true ||
        typeof state.passed !== "boolean")) ||
    (state.sandbox_id && !/^sbx_[a-z0-9]{26}$/.test(state.sandbox_id)) ||
    (state.process_id && !/^prc_[a-z0-9]{26}$/.test(state.process_id)) ||
    [state.create_operation, state.stop_operation, state.delete_operation].some(
      (id) => id && !/^op_[a-z0-9]{26}$/.test(id),
    )
  )
    throw new Error("Receipt is invalid or belongs to a different Ortam API or organization")
}

/** Reopening the same receipt resumes this check, never creates a second check.
 * Cleanup-only is useful after losing connectivity or interrupting the process. */
export async function runOrtamSmoke({
  statePath,
  apiKey,
  apiUrl = "https://api.ortam.dev/v1",
  cleanupOnly = false,
  fetcher = globalThis.fetch.bind(globalThis),
  pollMs = 2000,
  probeMs = PROBE_MS,
  cleanupMs = CLEANUP_MS,
  signal,
  onProgress = () => {},
}) {
  if (!apiKey) throw new Error("Set ORTAM_API_KEY to a Developer API key before running this check")
  const base = apiBase(apiUrl)
  const path = resolve(statePath)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // An abandoned lock is deliberately not stolen on a timer: the original process
  // might still be using the API. Recovery instructions require checking its PID.
  let lock
  try {
    lock = await open(`${path}.lock`, "wx", 0o600)
  } catch {
    throw new Error(`Receipt is locked. Check the PID in ${path}.lock before removing a stale lock`)
  }
  try {
    await lock.writeFile(`${process.pid}\n`)
    await lock.sync()
    const api = client(base, apiKey, fetcher)
    const organization = await api.authenticate()
    let state
    try {
      state = JSON.parse(await readFile(path, "utf8"))
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Receipt cannot be read; do not replace it while cleanup is outstanding")
      if (cleanupOnly) throw new Error("Cleanup requires an existing receipt")
      state = {
        version: 1,
        id: randomUUID(),
        api_url: base,
        organization,
        created_at: new Date().toISOString(),
        phase: "create",
        error: null,
      }
      await writeReceipt(path, state)
    }
    validateReceipt(state, base, organization)
    const save = async (patch) => {
      const next = { ...state, ...patch }
      validateReceipt(next, base, organization)
      await writeReceipt(path, next)
      state = next
      onProgress(state.phase)
    }
    const fail = async (reason) => save({ error: state.error ?? reason })
    let cleanupDeadline = state.cleanup_started_at ? Date.now() + cleanupMs : null
    const cleanup = async () => {
      cleanupDeadline ??= Date.now() + cleanupMs
      if (!state.cleanup_started_at) await save({ cleanup_started_at: new Date().toISOString() })
    }
    // A resumed launch may have succeeded before the response/receipt was lost.
    // Never repeat it: clean up and leave an honest unknown result instead.
    if (state.phase === "launch") {
      await fail("Process start outcome is unknown; the command was not repeated")
      await save({ phase: "stop" })
    }
    if (state.phase === "done") return state
    const deadline = Date.now() + probeMs
    let lastError = "Check did not finish"
    while (state.phase !== "done") {
      if (cleanupOnly || signal?.aborted || Date.now() >= deadline) {
        await fail(
          cleanupOnly
            ? "Cleanup requested"
            : signal?.aborted
              ? "Check interrupted"
              : "Check deadline exceeded",
        )
        await cleanup()
        if (["ready", "observe"].includes(state.phase)) await save({ phase: "stop" })
      }
      if (["stop", "delete"].includes(state.phase) && !state.cleanup_started_at) {
        await cleanup()
      }
      if (cleanupDeadline !== null && Date.now() >= cleanupDeadline)
        throw new Error(
          `${lastError}. Cleanup is unconfirmed; rerun with the same receipt and --cleanup-only`,
        )
      try {
        const sandboxPath = `/sandboxes/${state.sandbox_id}`
        const key = (action) => `derive-smoke-${state.id}-${action}`
        if (state.phase === "create") {
          // Write intent first; replay exactly this body/key after a lost response.
          const mutation = await api.request(
            "/sandboxes",
            "POST",
            {
              name: `derive-smoke-${state.id}`,
              size: "small",
              auto_stop_after_seconds: 300,
            },
            key("create"),
          )
          await save({
            sandbox_id: mutation.sandbox.id,
            create_operation: mutation.operation.id,
            phase: "ready",
          })
          validateReceipt(state, base, organization)
        } else if (state.phase === "ready") {
          const operation = await api.request(`/operations/${state.create_operation}`)
          if (operation.state === "failed") {
            await fail("Ortam could not create the test machine")
            await save({ phase: "stop" })
          } else if (operation.state === "succeeded") {
            const sandbox = await api.request(sandboxPath)
            if (sandbox.state !== "ready") {
              await fail("Test machine was not ready after creation")
              await save({ phase: "stop" })
            } else {
              // Ortam process starts have no idempotency key. Persist consumed
              // intent BEFORE issuing it; a crash here is a missed check, not a duplicate.
              await save({ phase: "launch" })
              try {
                const process = await api.request(`${sandboxPath}/processes`, "POST", {
                  argv: ["/usr/bin/printf", "%s\\n", `derive-ortam-ok:${state.id}`],
                  cwd: "/home/ortam",
                  timeout_seconds: 30,
                })
                await save({ process_id: process.id, phase: "observe" })
                validateReceipt(state, base, organization)
              } catch {
                await fail("Process start outcome is unknown; the command was not repeated")
                await save({ phase: "stop" })
              }
            }
          }
        } else if (state.phase === "observe") {
          const process = await api.request(
            `${sandboxPath}/processes/${state.process_id}?tail_bytes=4096`,
          )
          if (!["starting", "running"].includes(process.status)) {
            const result = {
              status: process.status,
              exit_code: process.exit_code ?? null,
              stdout: process.stdout ?? "",
              stderr: process.stderr ?? "",
              stdout_truncated: process.stdout_truncated,
              stderr_truncated: process.stderr_truncated,
            }
            const passed = !(
              result.status !== "exited" ||
              result.exit_code !== 0 ||
              result.stdout !== `derive-ortam-ok:${state.id}\n` ||
              result.stderr !== "" ||
              result.stdout_truncated ||
              result.stderr_truncated
            )
            await save({
              result,
              phase: "stop",
              error: passed
                ? state.error
                : "Test command did not return the expected successful result",
            })
          }
        } else if (state.phase === "stop") {
          if (state.stop_operation) {
            const operation = await api.request(`/operations/${state.stop_operation}`)
            if (operation.state === "succeeded" || operation.state === "failed") {
              if (operation.state === "failed")
                await fail("Ortam stop failed; deleting the disposable test machine")
              await save({ stop_status: operation.state, phase: "delete" })
            }
          } else if (state.stop_requested) {
            const operation = await api.request(
              `${sandboxPath}/stop`,
              "POST",
              undefined,
              key("stop"),
            )
            await save({ stop_operation: operation.id })
          } else {
            const sandbox = await api.request(sandboxPath)
            if (sandbox.current_operation_id) {
              // Includes provisioning and Ortam's automatic stop. Wait for the
              // existing owner rather than submitting a competing operation.
            } else if (sandbox.state === "ready") {
              await save({ stop_requested: true })
            } else if (["stopped", "failed"].includes(sandbox.state)) {
              await fail(
                sandbox.state === "failed"
                  ? "Test machine entered a failed state"
                  : "Test machine stopped before this check requested stop",
              )
              await save({ stop_status: sandbox.state, phase: "delete" })
            } else throw new Error("Unexpected test machine state; cleanup is unconfirmed")
          }
        } else if (state.phase === "delete") {
          if (!state.delete_operation) {
            const operation = await api.request(sandboxPath, "DELETE", undefined, key("delete"), {
              "X-Ortam-Confirm-Delete": state.sandbox_id,
            })
            await save({ delete_operation: operation.id })
          } else {
            const operation = await api.request(`/operations/${state.delete_operation}`)
            if (operation.state === "succeeded")
              await save({
                phase: "done",
                cleanup_confirmed: true,
                completed_at: new Date().toISOString(),
                passed: !state.error && !!state.result && state.stop_status === "succeeded",
              })
            else if (operation.state === "failed")
              throw new CleanupUnconfirmed(
                "Ortam deletion failed. Cleanup is unconfirmed; inspect the saved operation before retiring the receipt",
              )
          }
        }
      } catch (error) {
        if (error instanceof CleanupUnconfirmed) throw error
        lastError = error.message
        onProgress(lastError)
      }
      if (state.phase !== "done") await delay(pollMs)
    }
    return state
  } finally {
    await lock.close()
    await rm(`${path}.lock`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm test:ortam --state <receipt.json> [--cleanup-only]\nRequires ORTAM_API_KEY; optional ORTAM_API_URL. Creates paid compute, then stops and deletes only its test machine.",
    )
    return
  }
  const index = args.indexOf("--state")
  const path = index >= 0 ? args[index + 1] : undefined
  const expected = new Set(["--state", path, "--cleanup-only"])
  if (!path || path.startsWith("--") || args.some((arg) => !expected.has(arg)))
    throw new Error(
      "Pass --state <receipt.json>; use the same path to recover an interrupted check",
    )
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  try {
    const result = await runOrtamSmoke({
      statePath: path,
      apiKey: process.env.ORTAM_API_KEY,
      apiUrl: process.env.ORTAM_API_URL,
      cleanupOnly: args.includes("--cleanup-only"),
      signal: controller.signal,
      onProgress: (message) => console.log(message),
    })
    console.log(`${result.passed ? "PASS" : "FAIL"}: cleanup confirmed. Receipt: ${resolve(path)}`)
    if (!result.passed) process.exitCode = 1
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
