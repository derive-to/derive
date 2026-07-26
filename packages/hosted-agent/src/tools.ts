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
