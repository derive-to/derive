import { z } from "zod"
import type { ToolContext } from "../mcp-tool-context"

// CLEAR QUEUE — the write half of the work queue -------------------------------
// `catch_up` with no short_id READS the @mention inbox; this clears what you have
// handled off it. They were one tool, discriminated by an `ack` parameter, and the
// merge was the reason `catch_up` carried readOnlyHint:true while quietly writing.
//
// The hint mattered for a real reason worth preserving: planning-mode clients gate
// on readOnlyHint, and gating the START-HERE call behind an approval prompt makes
// the loop worse for everyone. Splitting keeps that property honestly instead of by
// assertion — `catch_up` now reads and only reads, so its hint is true rather than
// nearly true, and the write lives here where a prompt costs nothing (acking is rare,
// and it happens after the agent has already done the work).
//
// Acking is idempotent by construction: the store matches a row whether or not it was
// already acknowledged, and `acked` counts what actually LEFT the queue, so a repeated
// or unknown id can never inflate it. That is what idempotentHint claims here, and it
// is a different claim from readOnly — the conflation of those two is exactly what put
// the wrong hint on `catch_up` in the first place.
export function registerClearQueueTool(tc: ToolContext): void {
  const { server, workQueue } = tc

  server.registerTool(
    "clear_queue",
    {
      description:
        "Clear finished items off your WORK QUEUE: pass the request ids you have HANDLED. Returns what is still pending. `catch_up` with no short_id is the read side. See derive://skills/loop.",
      annotations: {
        title: "Clear handled work",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ack: z.array(z.string()).describe("Request ids you have HANDLED, from catch_up's queue."),
      },
    },
    async ({ ack }) => workQueue(ack),
  )
}
