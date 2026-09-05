import type {
  WorkerLoader,
  WorkerLoaderWorkerCode,
  WorkerStub,
  WorkerStubEntrypointOptions,
} from "@cloudflare/workers-types"
import {
  clipSandboxLogs,
  clipSandboxValue,
  MAX_CODE_TOOL_CALLS,
  MAX_LOG_CHARS,
  MAX_LOG_ENTRIES,
  type Sandbox,
  type SandboxResult,
} from "./code-sandbox"

/** Model-written orchestration is I/O work. A synchronous loop gets a much smaller CPU budget. */
const MAX_CODE_CPU_MS = 5_000
type CodemodeModule = typeof import("@cloudflare/codemode")
type CodemodeLoader = ConstructorParameters<CodemodeModule["DynamicWorkerExecutor"]>[0]["loader"]
type HostCallRunner = <T>(call: () => Promise<T>) => Promise<T>

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const withLimits = (code: WorkerLoaderWorkerCode, timeoutMs: number): WorkerLoaderWorkerCode => ({
  ...code,
  limits: {
    ...code.limits,
    cpuMs: Math.min(code.limits?.cpuMs ?? MAX_CODE_CPU_MS, timeoutMs, MAX_CODE_CPU_MS),
  },
})

const cpuLimit = (timeoutMs: number): number => Math.min(timeoutMs, MAX_CODE_CPU_MS)

/** Apply the limit at invocation time too, so the lower limit wins at both layers. */
const boundedStub = (stub: WorkerStub, timeoutMs: number): WorkerStub =>
  new Proxy(stub, {
    get: (target, property) => {
      if (property === "getEntrypoint")
        return (name?: string, options?: WorkerStubEntrypointOptions) =>
          target.getEntrypoint(name, {
            ...options,
            limits: { ...options?.limits, cpuMs: cpuLimit(timeoutMs) },
          })
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

/** Apply CPU limits that the SDK's Promise timeout cannot enforce on a synchronous loop. */
const boundedLoader = (loader: WorkerLoader, timeoutMs: number): WorkerLoader => ({
  get: (name, getCode) =>
    boundedStub(
      loader.get(name, async () => withLimits(await getCode(), timeoutMs)),
      timeoutMs,
    ),
  load: (code) => boundedStub(loader.load(withLimits(code, timeoutMs)), timeoutMs),
})

const SANDBOX_PRELUDE = `
const __derive_tool_names = await __derive_tools.toolNames({})
const __derive_bulk_tool_names = await __derive_tools.bulkToolNames({})
const __derive_available_tools = __derive_tool_names.join(", ")
const tools = Object.freeze(Object.fromEntries(
  [
    ...__derive_tool_names.map((name) => [
      name,
      (args) => __derive_tools.callTool({ name, args: args ?? {} }),
    ]),
    ...__derive_bulk_tool_names.map((name) => [
      name + "Many",
      (args, options) => __derive_tools.callTools({ name, args, options: options ?? {} }),
    ]),
  ],
))
const call_tool = async (name, args) => {
  const normalized = String(name)
  const fn = tools[normalized]
  return typeof fn === "function"
    ? fn(args ?? {})
    : { error: "unknown tool: " + normalized + ". Available: " + __derive_available_tools }
}
let __derive_log_count = 0
let __derive_log_chars = 0
const __derive_console_log = console.log
const __derive_console_warn = console.warn
const __derive_console_error = console.error
const __derive_log_value = (value) => {
  if (typeof value === "string") return value
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}
const __derive_log_args = (values) => values.map(__derive_log_value).join(" ").slice(0, 2000)
const __derive_emit_log = (emit, values) => {
  if (__derive_log_count++ >= ${MAX_LOG_ENTRIES} || __derive_log_chars >= ${MAX_LOG_CHARS}) return
  const text = __derive_log_args(values).slice(0, ${MAX_LOG_CHARS} - __derive_log_chars)
  __derive_log_chars += text.length
  emit(text)
}
console.log = (...values) => __derive_emit_log(__derive_console_log, values)
console.warn = (...values) => __derive_emit_log(__derive_console_warn, values)
console.error = (...values) => __derive_emit_log(__derive_console_error, values)
`

/**
 * The hosted sandbox recommended by Cloudflare for Code Mode MCP servers.
 *
 * Each call creates a Dynamic Worker with no parent bindings or outbound network. Tool calls
 * cross Workers RPC back into the static Derive Worker, which owns the caller-scoped handlers.
 */
export const cloudflareSandbox = (
  loader: WorkerLoader,
  captureHostCallRunner: () => HostCallRunner = () => (call) => call(),
): Sandbox => ({
  name: "cloudflare-dynamic-worker",
  async run({ code, host, timeoutMs }): Promise<SandboxResult> {
    // Keep the Cloudflare-only package out of the Node module graph. The Node test suite imports
    // worker.ts to verify fail-closed startup, but it never runs this adapter.
    const { DynamicWorkerExecutor } = await import("@cloudflare/codemode")
    // Worker RPC callbacks run in a separate async context. Capture the host request context
    // before entering the Dynamic Worker, then restore it around each caller-scoped tool handler.
    const runHostCall = captureHostCallRunner()
    const toolCalls: string[] = []
    const fns = {
      toolNames: async () => host.toolNames,
      bulkToolNames: async () => host.bulkToolNames ?? [],
      callTool: async (input: unknown) => {
        const record =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {}
        const name = typeof record.name === "string" ? record.name : ""
        if (!host.toolNames.includes(name))
          return { error: `unknown tool: ${name}. Available: ${host.toolNames.join(", ")}` }
        if (toolCalls.length >= MAX_CODE_TOOL_CALLS)
          return { error: `tool call limit exceeded (${MAX_CODE_TOOL_CALLS})` }
        toolCalls.push(name)
        try {
          const args =
            record.args && typeof record.args === "object" && !Array.isArray(record.args)
              ? (record.args as Record<string, unknown>)
              : {}
          const call = () => host.callTool(name, args)
          return await runHostCall(call)
        } catch (error) {
          return { error: messageOf(error) }
        }
      },
      callTools: async (input: unknown) => {
        const record =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {}
        const name = typeof record.name === "string" ? record.name : ""
        const args = Array.isArray(record.args) ? (record.args as Record<string, unknown>[]) : []
        const callTools = host.callTools
        if (!callTools || !host.bulkToolNames?.includes(name))
          return { error: `bulk tool unavailable: ${name}Many` }
        if (toolCalls.length + args.length > MAX_CODE_TOOL_CALLS)
          return { error: `tool call limit exceeded (${MAX_CODE_TOOL_CALLS})` }
        toolCalls.push(...args.map(() => name))
        try {
          const options =
            record.options && typeof record.options === "object" && !Array.isArray(record.options)
              ? (record.options as Record<string, unknown>)
              : {}
          return await runHostCall(() => callTools(name, args, options))
        } catch (error) {
          return { error: messageOf(error) }
        }
      },
    }

    const executor = new DynamicWorkerExecutor({
      // The SDK ships its WorkerLoader type through `cloudflare:workers`; this app gets the same
      // runtime binding from generated Wrangler types. They are structurally identical at
      // runtime, but their generic Fetcher declarations are not assignable across packages.
      loader: boundedLoader(loader, timeoutMs) as unknown as CodemodeLoader,
      timeout: timeoutMs,
      globalOutbound: null,
    })

    try {
      const result = await executor.execute(code, [
        {
          name: "__derive_tools",
          fns,
          prelude: SANDBOX_PRELUDE,
        },
      ])
      return {
        value: result.error ? null : clipSandboxValue(result.result),
        logs: clipSandboxLogs(result.logs ?? []),
        toolCalls,
        ...(result.error ? { error: result.error } : {}),
      }
    } catch (error) {
      return { value: null, logs: [], toolCalls, error: messageOf(error) }
    }
  },
})
