import { z } from "zod"
import {
  AGENT_SURFACE_HELP,
  DEFAULT_CODE_TIMEOUT_MS,
  MAX_CODE_TIMEOUT_MS,
  type Sandbox,
} from "../lib/code-sandbox"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"
import { CODE_READ_ENVELOPE, type CodeReadEnvelope } from "./read"

/**
 * The DERIVE_CODE tool: do many reads in one call.
 *
 * The problem it solves is both latency and tokens. A broad find followed by parallel focused
 * reads should cross the MCP boundary once, and only the selected result should enter context.
 *
 * Only `find` and `read` are available. Code Mode is one outer MCP approval, so including a write
 * would hide the operation that needed approval. The allow-list is constructed here rather than
 * in model-written code: an omitted handler is unreachable, even by adversarial code.
 *
 * The permissions are the CALLER'S. The sandbox never holds a credential; it posts a tool name
 * to the host, which runs that tool through the same handler and the same grant checks an
 * ordinary MCP call would hit. Code can therefore do exactly what this session could already do
 * by hand. `tool_calls` in the result records the reads it did.
 */
const CODE_TOOL_NAMES = ["find", "read"] as const
const BULK_MAX = 50
const BULK_CONCURRENCY = 12
const COMPACT_DEFAULT_CHARS = 2_000
const COMPACT_MIN_CHARS = 300
const COMPACT_MAX_CHARS = 6_000

type BulkOptions = { mode?: unknown; max_chars?: unknown }
type BulkItem = { index: number; value: unknown }

const stableJson = (value: unknown): string => {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`
}

const hasError = (value: unknown): boolean =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).error === "string"

const compactValue = (value: unknown, maxChars: number): unknown => {
  const serialized = JSON.stringify(value) ?? String(value)
  if (serialized.length <= maxChars) return value
  if (typeof value === "string")
    return { preview: value.slice(0, maxChars), chars: value.length, truncated: true }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  if (!record)
    return { preview: serialized.slice(0, maxChars), chars: serialized.length, truncated: true }

  const compact: Record<string, unknown> = {}
  for (const key of [
    "short_id",
    "title",
    "version",
    "kind",
    "format",
    "url",
    "focus",
    "count",
    "total",
    "truncated",
  ]) {
    if (record[key] !== undefined) compact[key] = record[key]
  }
  if (Array.isArray(record.matches)) {
    compact.matches = record.matches.slice(0, 3).map((match) => {
      if (!match || typeof match !== "object" || Array.isArray(match)) return match
      const row = match as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(row).map(([key, item]) => [
          key,
          typeof item === "string" ? item.slice(0, Math.floor(maxChars / 3)) : item,
        ]),
      )
    })
  }
  const compactJson = JSON.stringify(compact)
  if (compactJson.length > 2 && compactJson.length <= maxChars)
    return { ...compact, chars: serialized.length, truncated: true }
  return { preview: serialized.slice(0, maxChars), chars: serialized.length, truncated: true }
}

const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Give sandbox code the useful value, not the MCP transport envelope around it. */
const unwrapToolResult = (result: unknown): unknown => {
  if (!result || typeof result !== "object") return result
  const value = result as {
    toolResult?: unknown
    structuredContent?: unknown
    isError?: boolean
    content?: { type?: string; text?: string }[]
  }
  if ("toolResult" in value) return value.toolResult
  const content = Array.isArray(value.content) ? value.content : []
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
  if (value.isError) return { error: text || "tool call failed" }
  if (value.structuredContent !== undefined) return value.structuredContent
  if (content.length && content.every((part) => part.type === "text")) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return result
}

export function registerCodeTool(
  tc: ToolContext,
  /** The handlers captured from the caller-scoped MCP surface. */
  registry: Map<string, (input: Record<string, unknown>) => Promise<unknown>>,
  sandbox: Sandbox,
): void {
  const { server } = tc
  const toolNames = CODE_TOOL_NAMES.filter((name) => registry.has(name))

  const callOne = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const handler = registry.get(name)
    if (!handler || name === "derive_code")
      return { error: `unknown tool: ${name}. Available: ${toolNames.join(", ")}` }
    return unwrapToolResult(await handler(args))
  }

  const preloadReads = async (
    requests: Record<string, unknown>[],
  ): Promise<Map<string, CodeReadEnvelope>> => {
    const shortIds = [
      ...new Set(
        requests
          .filter(
            (request) =>
              typeof request.short_id === "string" &&
              request.version === undefined &&
              request.data === undefined &&
              request.versions === undefined &&
              !String(request.short_id).startsWith("derive://") &&
              !String(request.short_id).startsWith("ctx_"),
          )
          .map((request) => String(request.short_id)),
      ),
    ]
    if (shortIds.length === 0) return new Map()
    const artifacts = await tc.ctx.meta.getByShortIds(shortIds)
    const versions = artifacts.length
      ? await tc.ctx.meta.currentVersions(artifacts.map((artifact) => artifact.id))
      : {}
    const byShortId = new Map(artifacts.map((artifact) => [artifact.short_id, artifact]))
    return new Map(
      shortIds.map((shortId) => {
        const artifact = byShortId.get(shortId)
        return [
          shortId,
          artifact ? { artifact, version: versions[artifact.id] ?? null } : null,
        ] as const
      }),
    )
  }

  const callMany = async (
    name: string,
    requests: Record<string, unknown>[],
    options: BulkOptions = {},
  ): Promise<unknown> => {
    if (!Array.isArray(requests) || requests.length === 0)
      return { error: `${name}Many needs a non-empty array.` }
    if (requests.length > BULK_MAX)
      return { error: `${name}Many accepts at most ${BULK_MAX} items.` }
    if (
      requests.some((request) => !request || typeof request !== "object" || Array.isArray(request))
    )
      return { error: `${name}Many items must be argument objects.` }

    const started = Date.now()
    const compact = options.mode === "compact"
    const requestedMax = Number(options.max_chars)
    const maxChars = Number.isFinite(requestedMax)
      ? Math.min(COMPACT_MAX_CHARS, Math.max(COMPACT_MIN_CHARS, Math.floor(requestedMax)))
      : COMPACT_DEFAULT_CHARS
    const unique = new Map<string, { args: Record<string, unknown>; indexes: number[] }>()
    requests.forEach((args, index) => {
      let key: string
      try {
        key = stableJson(args)
      } catch {
        // Cyclic or otherwise non-JSON arguments can still run. They only forfeit deduplication.
        key = `__unique_${index}`
      }
      const found = unique.get(key)
      if (found) found.indexes.push(index)
      else unique.set(key, { args, indexes: [index] })
    })

    let preloaded = new Map<string, CodeReadEnvelope>()
    if (name === "read") {
      try {
        preloaded = await preloadReads([...unique.values()].map(({ args }) => args))
      } catch {
        // The optimization is optional. Ordinary reads retain their established path.
        preloaded = new Map()
      }
    }
    const outcomes = await mapLimit([...unique.values()], BULK_CONCURRENCY, async (entry) => {
      try {
        const shortId = typeof entry.args.short_id === "string" ? entry.args.short_id : null
        const args =
          name === "read" && shortId && preloaded.has(shortId)
            ? Object.assign({}, entry.args, { [CODE_READ_ENVELOPE]: preloaded.get(shortId) })
            : entry.args
        const value = await callOne(name, args)
        return { entry, value, failed: hasError(value) }
      } catch {
        return { entry, value: null, failed: true }
      }
    })
    const results: BulkItem[] = []
    const skipped: { index: number; reason: "unavailable" }[] = []
    for (const { entry, value, failed } of outcomes) {
      for (const index of entry.indexes) {
        if (failed) skipped.push({ index, reason: "unavailable" })
        else results.push({ index, value: compact ? compactValue(value, maxChars) : value })
      }
    }
    results.sort((a, b) => a.index - b.index)
    skipped.sort((a, b) => a.index - b.index)
    return {
      results,
      skipped,
      stats: {
        requested: requests.length,
        completed: results.length,
        skipped: skipped.length,
        unique: unique.size,
        elapsed_ms: Date.now() - started,
        compact,
      },
    }
  }

  server.registerTool(
    "derive_code",
    {
      title: "Run code across Derive reads",
      description:
        `Prefer for 2+ searches/reads. Singles/renders/edits: find/read.\n\n` +
        // The SHARED description (lib/code-sandbox.ts), so the tool and the sandbox that runs
        // the code cannot drift into describing different surfaces.
        `${AGENT_SURFACE_HELP}\n\n` +
        `Available read-only tools: ${toolNames.join(", ")}.`,
      annotations: {
        title: "Run code across Derive reads",
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        code: z
          .string()
          .min(1)
          .max(20_000)
          .describe("JavaScript. `tools` is in scope; return the result. Top-level await is fine."),
        // coerce, not bare number: a client that connected before this parameter existed sends
        // it as a STRING, and a bare z.number() would reject a value the caller passed correctly.
        timeout_ms: z.coerce.number().int().positive().max(MAX_CODE_TIMEOUT_MS).optional(),
      },
    },
    async (input) => {
      const result = await sandbox.run({
        code: input.code,
        timeoutMs: input.timeout_ms ?? DEFAULT_CODE_TIMEOUT_MS,
        host: {
          toolNames,
          bulkToolNames: toolNames,
          callTool: callOne,
          callTools: callMany,
        },
      })

      // A failure still returns the logs and the calls that DID happen: when a composed script
      // dies halfway, what it managed first is the most useful thing a model can be told.
      if (result.error)
        return err(
          `code failed: ${result.error}` +
            (result.toolCalls.length ? `\ncalls made: ${result.toolCalls.join(", ")}` : "") +
            (result.logs.length ? `\nlogs:\n${result.logs.join("\n")}` : ""),
        )
      return json({
        result: result.value,
        ...(result.logs.length ? { logs: result.logs } : {}),
        // Echoed so the transcript records what one approval actually authorized.
        tool_calls: result.toolCalls,
      })
    },
  )
}
