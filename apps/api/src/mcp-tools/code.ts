import { AGENT_SURFACE_HELP } from "@derive/core"
import { z } from "zod"
import { DEFAULT_CODE_TIMEOUT_MS, MAX_CODE_TIMEOUT_MS, type Sandbox } from "../lib/code-sandbox"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

/**
 * The DERIVE_CODE tool: do several things in one call.
 *
 * The problem it solves is APPROVALS, not tokens. "Read these five artifacts, find the ones
 * mentioning Q3, and publish a summary" is a dozen tool calls, and in a supervised session that
 * is a dozen prompts for one intention. Here it is one call, one decision, and only the answer
 * comes back — the intermediate reads stay in the sandbox instead of crossing the context window.
 *
 * EVERY registered tool is available, deliberately. There is no read-only subset and no special
 * policy for writes, because Derive already HAS a policy for that: the autonomy gate decides
 * publish-versus-propose from the target's mode and the workspace's flags (see decideWrite), and
 * a run that consumed untrusted content is demoted by taint regardless. A second, tool-specific
 * rule would contradict the first, and the annoying kind of surprise is a tool that follows
 * different rules than the tool it wraps. `publish` called from here IS `publish`.
 *
 * The permissions are the CALLER'S. The sandbox never holds a credential; it posts a tool name
 * to the host, which runs that tool through the same handler and the same grant checks an
 * ordinary MCP call would hit. Code can therefore do exactly what this session could already do
 * by hand — no more — and `tool_calls` in the result records what it did.
 */
export function registerCodeTool(
  tc: ToolContext,
  /** Every other tool, by name, captured as they registered. */
  registry: Map<string, (input: Record<string, unknown>) => Promise<unknown>>,
  sandbox: Sandbox,
): void {
  const { server } = tc
  // Itself excluded: a code tool that can call the code tool is a recursion the timeout would
  // eventually stop, expensively and confusingly.
  const toolNames = [...registry.keys()].filter((n) => n !== "derive_code").sort()

  server.registerTool(
    "derive_code",
    {
      title: "Run code across Derive's tools",
      description:
        `Do SEVERAL things in one call, instead of a chain of separate calls.\n\n` +
        // The SHARED description (packages/core/src/agent-surface.ts), so this tool and the
        // container's run prompt cannot drift into describing different products.
        `${AGENT_SURFACE_HELP}\n\n` +
        `Available: ${toolNames.join(", ")}.\n\n` +
        `Tools behave exactly as they do when called directly, including how writes land ` +
        `(publish vs proposal is the workspace's setting, never this tool's).\n\n` +
        `Example: const found = []; for (const a of (await tools.find({ query: "roadmap" })).results) ` +
        `{ const doc = await tools.read({ short_id: a.short_id }); if (doc.markdown.includes("Q3")) found.push(a.short_id) } ` +
        `return found`,
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
            return handler(args)
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
