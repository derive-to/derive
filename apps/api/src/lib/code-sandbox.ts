/**
 * The CODE SANDBOX seam: run model-written JavaScript that may call Derive's tools, without
 * letting it reach anything else.
 *
 * Why this exists. Every tool call is an approval decision, and a job that reads five artifacts
 * and publishes one summary is a dozen of them. One `derive_code` call that does the whole thing
 * is one decision — which is the real argument for code mode, more than tokens or latency.
 *
 * A seam rather than an implementation, for the same reason Substrate is one: the isolate differs
 * by platform and nothing else does. Node self-host gets a worker thread; Cloudflare needs the
 * Worker Loader (dynamic isolates), which is beta. The tool, the host bridge, the result handling
 * and the tests are shared, so adding the Workers isolate later is one file, not a second
 * implementation of code mode.
 *
 * THE THREAT. This runs text a model wrote, and that model may have read a hostile web page. The
 * sandbox must therefore assume the code is adversarial, not merely buggy. Two properties carry
 * everything:
 *
 *   1. The sandbox holds NO SECRETS. The worker is spawned with `env: {}`, so DERIVE_AUTH_SECRET,
 *      DATABASE_URL and every key live only on the host side. An escape that yields full realm
 *      access still finds an empty environment and no database handle.
 *   2. Tools are MARSHALLED, never handed over. The sandbox gets a function that posts a message;
 *      the host runs the real tool with the caller's own permissions. So code can do exactly what
 *      the MCP session could already do by hand — no more — and every call stays auditable.
 *
 * Node's `vm` is NOT a security boundary on its own: `x.constructor.constructor` walks from any
 * host-created object out to the host `Function`, and from there to `process` and `require`. The
 * worker thread is the real boundary (separate heap, empty env); the in-context hardening prelude
 * closes the known escape so the two layers have to fail together.
 *
 * Adapted from Sift's execute_siftgpt_code, which solved the same problem for the same reasons.
 */

/** What the sandbox may call back into. The host runs these with the caller's own permissions. */
export interface SandboxHost {
  /** Invoke one named tool. Unknown names return an error VALUE — never throw across the bridge,
   *  because a thrown host error would surface as an opaque sandbox crash instead of something
   *  the model can read and correct. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** The tool names the code may call, used to build the in-sandbox surface. */
  toolNames: string[]
}

export interface SandboxResult {
  /** The code's return value, structured-cloneable. */
  value: unknown
  /** Anything it logged, in order — the model's own trace of what it did. */
  logs: string[]
  /** Which tools it actually invoked, for the audit line and for taint. */
  toolCalls: string[]
  /** Set when the code threw or the sandbox refused it; `value` is then meaningless. */
  error?: string
}

export interface Sandbox {
  readonly name: string
  run(input: { code: string; host: SandboxHost; timeoutMs: number }): Promise<SandboxResult>
}

/** Wall-clock ceiling. Generous enough for a few tool round trips, short enough that a runaway
 *  loop is someone's 30-second annoyance rather than a wedged request. */
export const DEFAULT_CODE_TIMEOUT_MS = 30_000
export const MAX_CODE_TIMEOUT_MS = 120_000

/** Cap what crosses back. A sandbox returning a megabyte of JSON would blow up the model's
 *  context — the very thing code mode exists to avoid. */
export const MAX_LOG_ENTRIES = 200
export const MAX_RESULT_CHARS = 100_000

/**
 * The in-context hardening prelude, run BEFORE the model's code.
 *
 * It (1) re-exposes the host bridges as closures created INSIDE the vm realm, so
 * `fn.constructor.constructor` stays in-realm, (2) deep-copies every host result into vm-realm
 * objects so `result.constructor.constructor` does too, and (3) withdraws the raw bridges from
 * the global and shadows `Function`.
 *
 * The manual clone is deliberate: JSON round-tripping throws on a bigint, and a tool returning
 * one would take down the run rather than the value.
 */
export const SANDBOX_PRELUDE = `
const { tools, call_tool, console } = (() => {
  const __hcall = __derive_host_call_tool
  const __hlog = __derive_host_log
  const __clone = (v, depth) => {
    if (depth > 64 || v === null || typeof v !== "object") return v
    if (Array.isArray(v)) { const a = []; for (let i = 0; i < v.length; i++) a[i] = __clone(v[i], depth + 1); return a }
    const o = {}
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = __clone(v[k], depth + 1)
    return o
  }
  const call = async (name, args) => __clone(await __hcall(String(name), args || {}), 0)
  const tools = {}
  for (const n of __derive_tool_names) tools[n] = (args) => call(n, args)
  return {
    tools,
    call_tool: call,
    console: { log: (...vals) => __hlog(vals.map((v) => __clone(v, 0))) },
  }
})()
__derive_host_call_tool = undefined
__derive_host_log = undefined
const Function = undefined
`
