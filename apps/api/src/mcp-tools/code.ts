import { z } from "zod"
import {
  AGENT_SURFACE_HELP,
  DEFAULT_CODE_TIMEOUT_MS,
  MAX_CODE_TIMEOUT_MS,
  type Sandbox,
} from "../lib/code-sandbox"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

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

  server.registerTool(
    "derive_code",
    {
      title: "Run code across Derive reads",
      description:
        `Run many find and read calls in one MCP call. Use loops or Promise.all.\n\n` +
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
          callTool: async (name, args) => {
            const handler = registry.get(name)
            // An unknown name is the model's mistake, and it should read as data it can correct
            // rather than as a sandbox crash — hence a value, not a throw.
            if (!handler || name === "derive_code")
              return { error: `unknown tool: ${name}. Available: ${toolNames.join(", ")}` }
            return unwrapToolResult(await handler(args))
          },
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
