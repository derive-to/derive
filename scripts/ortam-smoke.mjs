#!/usr/bin/env node
// Disposable, opt-in qualification of Ortam's lifecycle API. This is not
// the hosted-run dispatcher. Keep its receipt until cleanup is confirmed.
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

const REQUEST_MS = 15_000
const PROBE_MS = 15 * 60_000
const CLEANUP_MS = 15 * 60_000
// How long the test machine may run if this check never stops it.
const SELF_STOP_SECONDS = 300
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
async function send(fetcher, url, init) {
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
  return response
}

// Ortam takes the API key as the bearer on every request. It has no token exchange and no
// call that names the key's organization: a machine the key cannot see reads as not found.
function client(apiUrl, apiKey, fetcher) {
  const call = (path, method, body, key) =>
    send(fetcher, `${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    /** Every mutation carries `key`: Ortam answers a repeat of the same key and body with
     *  the first result, so a lost response is retried, never guessed at. */
    async request(path, method = "GET", body, key) {
      const response = await call(path, method, body, key)
      try {
        return await response.json()
      } catch {
        throw new Error("Ortam returned invalid JSON")
      }
    },
    async text(path) {
      return (await call(path, "GET")).text()
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

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

function validateReceipt(state, apiUrl) {
  if (
    state?.version !== 2 ||
    !UUID.test(state.id ?? "") ||
    !phases.includes(state.phase) ||
    state.api_url !== apiUrl ||
    !Number.isFinite(Date.parse(state.created_at)) ||
    (state.phase !== "create" && (!state.sandbox_id || !state.create_operation)) ||
    (state.phase === "observe" && !state.execution_id) ||
    (state.phase === "done" &&
      (!state.delete_operation ||
        state.cleanup_confirmed !== true ||
        typeof state.passed !== "boolean")) ||
    [
      state.sandbox_id,
      state.execution_id,
      state.create_operation,
      state.stop_operation,
      state.delete_operation,
    ].some((id) => id && !UUID.test(id))
  )
    throw new Error("Receipt is invalid, from an older Ortam API, or belongs to a different one")
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
  if (!apiKey) throw new Error("Set ORTAM_API_KEY to an Ortam API key before running this check")
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
    // Proves the key works before anything is created or a receipt is written.
    await api.request("/sandboxes?limit=1")
    let state
    try {
      state = JSON.parse(await readFile(path, "utf8"))
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Receipt cannot be read; do not replace it while cleanup is outstanding")
      if (cleanupOnly) throw new Error("Cleanup requires an existing receipt")
      state = {
        version: 2,
        id: randomUUID(),
        api_url: base,
        created_at: new Date().toISOString(),
        phase: "create",
        error: null,
      }
      await writeReceipt(path, state)
    }
    validateReceipt(state, base)
    const save = async (patch) => {
      const next = { ...state, ...patch }
      validateReceipt(next, base)
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
        if (["ready", "launch", "observe"].includes(state.phase)) await save({ phase: "stop" })
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
          // A sandbox is created stopped: nothing runs, or bills compute, until the launch.
          const made = await api.request(
            "/sandboxes",
            "POST",
            { name: `derive-smoke-${state.id}`, size: "small" },
            key("create"),
          )
          await save({
            sandbox_id: made.resource.id,
            create_operation: made.operation.id,
            phase: "ready",
          })
        } else if (state.phase === "ready") {
          const operation = await api.request(`/operations/${state.create_operation}`)
          if (operation.state === "completed") await save({ phase: "launch" })
          else if (["failed", "unknown"].includes(operation.state)) {
            await fail("Ortam could not create the test machine")
            await save({ phase: "stop" })
          }
        } else if (state.phase === "launch") {
          // The command starts the stopped machine. Ortam never stops a running machine by
          // itself, so the command first arms a power-off: if this check dies here, the
          // machine still turns itself off, and Ortam saves it and reports it stopped.
          const launched = await api.request(
            `${sandboxPath}/executions`,
            "POST",
            {
              argv: [
                "sh",
                "-c",
                `(sleep ${SELF_STOP_SECONDS}; sudo poweroff) >/dev/null 2>&1 </dev/null &\nprintf '%s\\n' "$1"`,
                "derive-smoke",
                `derive-ortam-ok:${state.id}`,
              ],
              timeout_seconds: 30,
            },
            key("launch"),
          )
          await save({ execution_id: launched.resource.id, phase: "observe" })
        } else if (state.phase === "observe") {
          const run = `/executions/${state.execution_id}`
          const execution = await api.request(run)
          if (!["accepted", "running"].includes(execution.state)) {
            const output = await api.request(`${run}/output`)
            const read = (stream) =>
              output[stream].durable_end ? api.text(`${run}/output/${stream}?limit=4096`) : ""
            const result = {
              status: execution.state,
              exit_code: execution.exit_code ?? null,
              stdout: await read("stdout"),
              stderr: await read("stderr"),
              stdout_truncated: output.stdout.truncated,
              stderr_truncated: output.stderr.truncated,
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
            if (["completed", "failed", "unknown"].includes(operation.state)) {
              // A stop that saved nothing is not a stop this check can vouch for.
              const saved = operation.result?.final_save?.state === "published"
              const stopped = operation.state === "completed" && saved
              if (!stopped) await fail("Ortam stop failed; deleting the disposable test machine")
              await save({ stop_status: stopped ? "succeeded" : "failed", phase: "delete" })
            }
          } else if (state.stop_requested) {
            // Intent is saved first: after a lost response the machine reads as stopped,
            // and only the receipt says this check is what stopped it.
            const stop = await api.request(`${sandboxPath}/stop`, "POST", undefined, key("stop"))
            await save({ stop_operation: stop.operation.id })
          } else {
            const sandbox = await api.request(sandboxPath)
            if (sandbox.phase === "running") await save({ stop_requested: true })
            else if (["stopped", "lost", "deleted"].includes(sandbox.phase)) {
              // Never started is the ordinary end of a failed create or launch; a machine
              // that ran and is no longer running was stopped by something else.
              await fail(
                sandbox.phase === "stopped"
                  ? "Test machine stopped before this check requested stop"
                  : `Test machine was ${sandbox.phase} before this check requested stop`,
              )
              await save({ stop_status: sandbox.phase, phase: "delete" })
            }
            // `starting` and `stopping` are Ortam's own transitions: wait for them.
          }
        } else if (state.phase === "delete") {
          if (!state.delete_operation) {
            const deleted = await api.request(sandboxPath, "DELETE", undefined, key("delete"))
            await save({ delete_operation: deleted.operation.id })
          } else {
            const operation = await api.request(`/operations/${state.delete_operation}`)
            if (operation.state === "completed")
              await save({
                phase: "done",
                cleanup_confirmed: true,
                completed_at: new Date().toISOString(),
                passed: !state.error && !!state.result && state.stop_status === "succeeded",
              })
            else if (["failed", "unknown"].includes(operation.state))
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
