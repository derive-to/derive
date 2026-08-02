import { z } from "zod"
import { brokerFor, callTool } from "../lib/broker"
import { boundSources, sourceTools } from "../lib/chat-sources"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

/**
 * INVOKE ONE TOOL on one connected source.
 *
 * The only tool this surface adds for sources, deliberately. MCP schemas are large and the
 * chat surface has a size budget that has already forced trimming, so declaring every tool of
 * every connected server would blow it. Instead the turn reads `derive://sources` for what is
 * available, reads one catalog for its schemas, and calls — the disclosure shape the skills
 * index already uses, applied to tool definitions.
 *
 * IT IS NOT A SECOND PATH TO A CREDENTIAL. Authorization is `sourceTools`, which returns
 * nothing for a connection the workspace has not declared for chat, and execution is the same
 * `callTool` the run and ask lanes share. So a conversation can reach exactly what an admin
 * said it may, executed the way every other lane executes it.
 *
 * The trade this accepts: a model picks better from natively-declared tools than from
 * discover-then-invoke, and native declarations validate arguments for free. Here the schema is
 * fetched and the mismatch is returned as a tool result the model can correct — a bad call
 * costs one call, never the run.
 */
export function registerCallTool(tc: ToolContext): void {
  const { server, ctx, actingFor, ownerId, resolveWs, wsArg } = tc

  server.registerTool(
    "call",
    {
      description:
        "Run a tool on a CONNECTED SOURCE (Stripe, a Postgres, an MCP server your workspace " +
        "connected). Two steps first: `read('derive://sources')` lists what this workspace has " +
        "made available here, and `read('derive://sources/<id>')` gives one source's tools and " +
        "their arguments. Then call with `source` (the id), `tool` (its name) and `args`. " +
        "Only sources an admin has declared for chat are reachable; a connection existing is " +
        "not the same as a conversation being allowed to spend it. Cite what you used in your " +
        "answer, the same as you would a document.",
      inputSchema: {
        source: z.string().describe("Connection id, from read('derive://sources')."),
        tool: z.string().describe("Tool name, from that source's catalog."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments, shaped by the tool's params in the catalog."),
        workspace: wsArg,
      },
    },
    async (a: {
      source: string
      tool: string
      args?: Record<string, unknown>
      workspace?: string
    }) => {
      const ws = await resolveWs(a.workspace)
      if ("error" in ws) return err(ws.error)
      const owner = actingFor?.id ?? ownerId

      // Authorization and the tool list are ONE lookup: an undeclared source yields no tools,
      // so there is no ordering in which a check could be skipped and a call still succeed.
      const allowed = await sourceTools(ctx.meta, ws.org, owner, ctx.deps.encryptionKey, a.source)
      if (allowed.length === 0) {
        const bound = await boundSources(ctx.meta, ws.org, owner)
        return err(
          bound.length === 0
            ? "No connected sources are available to chat in this workspace. An admin declares them in settings; connecting a server does not by itself expose it here."
            : `Source "${a.source}" is not available to chat here. Available: ${bound.map((b) => `${b.toolkit} (${b.id})`).join(", ")}.`,
        )
      }

      const known = allowed.find((t) => t.def.name === a.tool)
      if (!known)
        return err(
          `No tool "${a.tool}" on that source. It offers: ${allowed.map((t) => t.def.name).join(", ")}. Read derive://sources/${a.source} for their arguments.`,
        )

      const broker = await brokerFor(ctx.meta, ws.org, owner, ctx.deps.encryptionKey)
      const out = await callTool({
        meta: ctx.meta,
        broker,
        orgId: ws.org,
        encryptionKey: ctx.deps.encryptionKey,
        allowed,
        subject: `chat:${a.source}`,
        tool: a.tool,
        args: a.args ?? {},
        ref: known.ref,
      })
      // A refusal from the source is the MODEL's to act on — wrong argument, missing scope,
      // a record that does not exist are all things it can correct or report. Returned as a
      // result rather than thrown for the same reason every other tool does it.
      if (!out.ok) return err(`${a.tool} failed (${out.status}): ${out.message}`)
      return json({ source: a.source, tool: a.tool, result: out.result })
    },
  )
}
