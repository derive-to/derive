import type { BrokerToolDef } from "@derive/broker"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import type { HostedAgentClient } from "./client"
import { type SubmitContext, submitRevision } from "./submit"

// The hosted agent's tools: each wraps exactly one public-API action as the
// agent's own principal (via the client's bearer), plus the terminal
// submit_revision which runs the autonomy gate. Built PER RUN so submit_revision
// closes over that run's latch and workspace flags — one agent invocation, one
// latch, no cross-run leakage. Framework-thin: the logic lives in submit.ts.

export interface RunContext extends SubmitContext {
  client: HostedAgentClient
  /** The run's SOURCE tools, already wrapped (buildBrokerTools) and bound to this run's
   *  executeTool proxy. The default runOne merges these into the agent so a pull run can fetch
   *  from its bound connections; absent/empty when the automation binds no sources. */
  extraTools?: Record<string, ReturnType<typeof createTool>>
}

export function buildTools(ctx: RunContext) {
  const read = createTool({
    id: "read_artifact",
    description: "Read the current source text of an artifact by its short id.",
    inputSchema: z.object({ shortId: z.string().describe("The artifact's short id.") }),
    execute: async ({ shortId }) => ({ content: await ctx.client.read(shortId) }),
  })

  const comment = createTool({
    id: "comment",
    description: "Leave a comment on an artifact, optionally anchored to a quoted span.",
    inputSchema: z.object({
      shortId: z.string(),
      body_md: z.string().describe("The comment text (Markdown)."),
      quote: z.string().optional().describe("Exact text to anchor the comment to."),
    }),
    execute: async ({ shortId, body_md, quote }) => {
      await ctx.client.comment(shortId, { body_md, quote })
      return { ok: true }
    },
  })

  // Terminal. The model calls this with the full proposed source; the autonomy
  // gate decides whether it publishes live (with a review round), files a
  // proposal, or records a shadow. The model does NOT choose the write mode —
  // "a model-supplied decision could only ever be wrong" (Sift's rule). A small
  // per-run budget (default 3 writes) bounds how many times this can act.
  const submit_revision = createTool({
    id: "submit_revision",
    description:
      "Submit the full source of an artifact: pass shortId to revise an existing one, or omit shortId (and give a title) to create a new artifact when the task asks for one. Derive decides whether it publishes for review, files a proposal, or is recorded — you never choose. Budget: a few writes per run; prefer one.",
    inputSchema: z.object({
      shortId: z
        .string()
        .optional()
        .describe("The artifact to revise. OMIT to create a new artifact."),
      title: z.string().optional().describe("Title when creating; ignored on revision."),
      content: z.string().describe("The COMPLETE new source of the artifact."),
      filename: z.string().describe("index.html or notes.md — sets the content type."),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .nullable()
        .describe("Your confidence in this write, 0 to 1; null if you can't say."),
      message: z.string().optional().describe("A one-line version message."),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Comment thread ids this revision resolves."),
    }),
    execute: async (input) => submitRevision(ctx, input),
  })

  return { read_artifact: read, comment, submit_revision }
}

/** Execute one source tool: (broker ref, tool name, args) → result. The executor never holds
 *  the broker or its credentials — this proxies back to the API (POST /v1/agent/runs/:id/tool),
 *  which runs the call server-side and re-checks that the ref belongs to the run's bound
 *  connections. Bound to a single run by the caller, so a tool can only reach that run's sources. */
export type ToolExecutor = (ref: string, tool: string, args: unknown) => Promise<unknown>

/**
 * Wrap a hosted run's LEAST-PRIVILEGE source tools as Mastra tools. `tools` is exactly the set
 * resolved from the run's bound connections (see toolsForRun in the host), so the model can only
 * reach those; each tool executes through the connected-account ref it was resolved with, and the
 * args the model supplies ride as DATA to `execute`. Execution proxies through the API so the
 * credentials never enter the executor. Keyed by a sanitized id so the host can merge them into
 * buildTools' set for one run.
 */
export function buildBrokerTools(
  tools: { def: BrokerToolDef; ref: string }[],
  execute: ToolExecutor,
): Record<string, ReturnType<typeof createTool>> {
  const out: Record<string, ReturnType<typeof createTool>> = {}
  for (const { def, ref } of tools) {
    const id = def.name.replace(/[^a-zA-Z0-9_]/g, "_")
    out[id] = createTool({
      id,
      description: def.description,
      inputSchema: z.object({
        args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments (data)."),
      }),
      execute: async ({ args }) => execute(ref, def.name, args ?? {}),
    })
  }
  return out
}
