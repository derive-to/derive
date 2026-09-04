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

const sandboxPrelude = (
  toolNames: string[],
  sanitizeToolName: (name: string) => string,
): string => {
  const available = toolNames.join(", ")
  const entries = toolNames
    .map(
      (name) =>
        `${JSON.stringify(name)}: (args) => __derive_tools[${JSON.stringify(
          sanitizeToolName(name),
        )}](args ?? {})`,
    )
    .join(",\n")

  return `
const tools = Object.freeze({
${entries}
})
const call_tool = async (name, args) => {
  const fn = tools[String(name)]
  return typeof fn === "function"
    ? fn(args ?? {})
    : { error: "unknown tool: " + String(name) + ". Available: ${available}" }
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
}

/**
 * The hosted sandbox recommended by Cloudflare for Code Mode MCP servers.
 *
 * Each call creates a Dynamic Worker with no parent bindings or outbound network. Tool calls
 * cross Workers RPC back into the static Derive Worker, which owns the caller-scoped handlers.
 */
export const cloudflareSandbox = (loader: WorkerLoader): Sandbox => ({
  name: "cloudflare-dynamic-worker",
  async run({ code, host, timeoutMs }): Promise<SandboxResult> {
    // Keep the Cloudflare-only package out of the Node module graph. The Node test suite imports
    // worker.ts to verify fail-closed startup, but it never runs this adapter.
    const { DynamicWorkerExecutor, sanitizeToolName } = await import("@cloudflare/codemode")
    const toolCalls: string[] = []
    const fns = Object.fromEntries(
      host.toolNames.map((name) => [
        name,
        async (args: unknown) => {
          if (toolCalls.length >= MAX_CODE_TOOL_CALLS)
            return { error: `tool call limit exceeded (${MAX_CODE_TOOL_CALLS})` }
          toolCalls.push(name)
          try {
            return await host.callTool(
              name,
              args && typeof args === "object" && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
            )
          } catch (error) {
            return { error: messageOf(error) }
          }
        },
      ]),
    )

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
          prelude: sandboxPrelude(host.toolNames, sanitizeToolName),
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
