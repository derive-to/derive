import { Worker } from "node:worker_threads"
import {
  MAX_LOG_ENTRIES,
  MAX_RESULT_CHARS,
  SANDBOX_PRELUDE,
  type Sandbox,
  type SandboxResult,
} from "./code-sandbox"

/**
 * The NODE sandbox: a worker thread with an empty environment.
 *
 * Spawned with `env: {}`, so the thread cannot read DERIVE_AUTH_SECRET, DATABASE_URL, or any
 * provider key — those exist only on the host side. It gets no database handle either: every
 * tool call is posted to the host, which runs the real tool with the caller's own permissions.
 * So even a total escape inside the worker finds an empty env and no data path, and the code can
 * still only do what the MCP session could already do by hand.
 *
 * Runs as CommonJS via `eval: true` so there is no separate file to bundle or resolve, and
 * communicates only structured-cloneable messages.
 *
 * Two timeouts, because they catch different things: the inner `vm` timeout bounds a synchronous
 * loop, and the host's wall-clock timer bounds everything else (an await that never settles,
 * a tool that hangs) by terminating the thread outright. A sandbox with only the inner timeout
 * hangs forever on `await new Promise(() => {})`.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const { code, prelude, toolNames, timeoutMs } = workerData
let __id = 0
const __pending = new Map()
const __call = (name, args) => new Promise((resolve) => {
  const id = ++__id
  __pending.set(id, resolve)
  parentPort.postMessage({ type: 'call_tool', id, name, args })
})
parentPort.on('message', (m) => {
  if (m && m.type === 'tool_result') {
    const r = __pending.get(m.id)
    if (r) { __pending.delete(m.id); r(m.result) }
  }
})
const sandbox = {
  __derive_host_call_tool: __call,
  __derive_host_log: (values) => parentPort.postMessage({ type: 'log', values }),
  __derive_tool_names: toolNames,
  // Explicitly undefined rather than merely absent: a bare identifier reference should read as
  // undefined instead of walking up to a real global on some future Node.
  process: undefined, require: undefined, module: undefined, globalThis: undefined,
  global: undefined, fetch: undefined, Buffer: undefined,
}
const wrapped = '(async () => {' + prelude + '\\n return await (async () => {' + code + '\\n})() })()'
;(async () => {
  try {
    const context = vm.createContext(sandbox)
    const started = new vm.Script(wrapped, { filename: 'derive-code.js' }).runInContext(context, { timeout: timeoutMs })
    const value = await started
    parentPort.postMessage({ type: 'done', value })
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: e && e.message ? String(e.message) : String(e) })
  }
})()
`

export const nodeSandbox = (): Sandbox => ({
  name: "node-worker",
  run: ({ code, host, timeoutMs }) =>
    new Promise<SandboxResult>((resolve) => {
      const logs: string[] = []
      const toolCalls: string[] = []
      let settled = false
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { code, prelude: SANDBOX_PRELUDE, toolNames: host.toolNames, timeoutMs },
        // THE boundary. An empty environment means an escape finds no secrets to take.
        env: {},
        // No stdio inheritance: the code must not be able to write to the server's logs.
        stdout: true,
        stderr: true,
      })
      const finish = (r: SandboxResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve({ ...r, logs, toolCalls })
      }
      // Wall clock, enforced HERE rather than inside the vm: the inner timeout only bounds
      // synchronous work, so a promise that never settles would otherwise hang the request.
      const timer = setTimeout(
        () =>
          finish({ value: null, logs, toolCalls, error: `code timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      worker.on("message", (m: { type: string; [k: string]: unknown }) => {
        if (m.type === "log") {
          // Bounded: a loop logging forever must not become the response.
          if (logs.length < MAX_LOG_ENTRIES)
            logs.push(
              (m.values as unknown[])
                .map((v) => (typeof v === "string" ? v : safeJson(v)))
                .join(" ")
                .slice(0, 2_000),
            )
          return
        }
        if (m.type === "call_tool") {
          const name = String(m.name)
          toolCalls.push(name)
          // The host runs the real tool. Errors come back as a VALUE so the model can read and
          // correct them, rather than as an opaque sandbox crash.
          host
            .callTool(name, (m.args as Record<string, unknown>) ?? {})
            .then((result) => worker.postMessage({ type: "tool_result", id: m.id, result }))
            .catch((e: Error) =>
              worker.postMessage({
                type: "tool_result",
                id: m.id,
                result: { error: e?.message ?? "tool failed" },
              }),
            )
          return
        }
        if (m.type === "done") finish({ value: clipValue(m.value), logs, toolCalls })
        if (m.type === "error") finish({ value: null, logs, toolCalls, error: String(m.error) })
      })
      worker.on("error", (e: unknown) =>
        finish({
          value: null,
          logs,
          toolCalls,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      worker.on("exit", (codeOut) => {
        // A worker that dies without reporting (OOM, an internal throw) must still settle the
        // request, or the caller waits for the full timeout on a thread that is already gone.
        if (!settled) finish({ value: null, logs, toolCalls, error: `sandbox exited (${codeOut})` })
      })
    }),
})

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Cap what crosses back into the model's context — returning a megabyte of JSON is the problem
 *  code mode exists to solve, not a feature of it.
 *
 *  Named clipVALUE, not clip: lib/clip.ts already owns `clip` for TEXT (it appends a
 *  "…[truncated]" suffix to a string). This takes an arbitrary value and returns a structured
 *  marker instead, so two different jobs should not share one name in the same app. */
const clipValue = (v: unknown): unknown => {
  const s = safeJson(v)
  if (s.length <= MAX_RESULT_CHARS) return v
  return {
    truncated: true,
    chars: s.length,
    preview: s.slice(0, MAX_RESULT_CHARS),
    hint: "Return a summary rather than the whole result — filter inside the code.",
  }
}
