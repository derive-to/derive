import { newId, roleAllows } from "@derive/core"
import { z } from "zod"
import { parseMeta, REACTIONS } from "../lib/comments"
import { notifyCommentBells } from "../lib/notify-comment"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

export function registerCommentTool(tc: ToolContext): void {
  const { server, ctx, agent, reach, notFound, wsArg } = tc

  // COMMENT — leave / reply / resolve feedback --------------------------------
  server.registerTool(
    "comment",
    {
      description:
        "Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread — all in one tool. Anchor a NEW comment to a quoted span of the rendered text with `quote`; reply by passing the thread id as `reply_to`; `react` (with `reply_to`) is the lightweight ack. Pass `set_state` (with the thread's id in `reply_to`) to RESOLVE that thread, or reopen it. Thread ids come from catch_up. For quoting, the ack, and review-round etiquette, read derive://skills/loop.",
      inputSchema: {
        short_id: z.string(),
        body: z
          .string()
          .optional()
          .describe("The comment text (Markdown). Omit when just reacting or changing state."),
        reply_to: z
          .string()
          .optional()
          .describe(
            "A thread id (from catch_up): reply in that thread, and/or the thread to react / set_state on.",
          ),
        quote: z
          .string()
          .optional()
          .describe("Exact text in the rendered document to anchor a NEW comment to."),
        react: z
          .enum(REACTIONS as [string, ...string[]])
          .optional()
          .describe(
            "React to the thread's latest comment by someone else (with `reply_to`) — the lightweight ack. 👍 is the loop's default.",
          ),
        set_state: z
          .enum(["resolved", "open"])
          .optional()
          .describe("Resolve the thread, or reopen it (with `reply_to`)."),
        workspace: wsArg,
      },
    },
    async ({ short_id, body, reply_to, quote, react, set_state, workspace }) => {
      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      const a = r.a
      if (!roleAllows(r.role, "comment"))
        return err(
          "Your grant is read-only (derive:read). Re-authorize the connector with derive:comment to leave feedback.",
        )
      if (!body && !set_state && !react)
        return err(
          "Provide `body` (to comment), `react` (to acknowledge), or `set_state` (to resolve/reopen).",
        )
      let thread = reply_to
      let commentId: string | undefined
      if (body) {
        commentId = newId("c")
        thread = reply_to || commentId
        const anchor = quote ? JSON.stringify({ type: "TextQuoteSelector", exact: quote }) : null
        await ctx.meta.createComment({
          id: commentId,
          artifact_id: a.id,
          thread_id: thread,
          base_version: a.current_version,
          path: null,
          anchor,
          body_md: body,
          author: agent.name,
          author_id: agent.id,
        })
        ctx.bus.publish(a.id, { type: "comment.created" })
        // Same bell fan-out as the HTTP route: thread participants + the
        // artifact's owners hear the agent's reply even with no tab open.
        // (Previously this path belled no one.) The MCP tool has no mentions.
        const created = await ctx.meta.getComment(commentId)
        if (created)
          await notifyCommentBells({ meta: ctx.meta, bus: ctx.bus }, a, created, {
            mentionIds: new Set(),
            actorId: agent.id,
          })
      }
      // The ack: land the emoji on the thread's newest comment by someone ELSE
      // (the human being acknowledged), falling back to its newest comment.
      // Idempotent — re-acking never toggles the reaction off.
      let reactedTo: string | undefined
      if (react) {
        if (!thread) return err("`react` needs `reply_to` (the thread to acknowledge).")
        const inThread = (await ctx.meta.listComments(a.id)).filter(
          (c) => c.thread_id === thread && !parseMeta(c.meta).deleted,
        )
        if (inThread.length === 0) return err(`No thread "${thread}" on "${short_id}".`)
        const target =
          [...inThread].reverse().find((c) => c.author_id !== agent.id) ??
          inThread[inThread.length - 1]
        if (target) {
          const md = parseMeta(target.meta)
          const reactions = md.reactions ?? {}
          const arr = reactions[react] ?? []
          if (!arr.includes(agent.name)) arr.push(agent.name)
          reactions[react] = arr
          md.reactions = reactions
          await ctx.meta.updateComment(target.id, { meta: JSON.stringify(md) })
          ctx.bus.publish(a.id, { type: "comment.reacted", thread_id: thread })
          reactedTo = target.id
        }
      }
      if (set_state) {
        if (!thread) return err("`set_state` needs `reply_to` (the thread id to resolve/reopen).")
        await ctx.meta.setThreadState(a.id, thread, set_state)
        ctx.bus.publish(a.id, { type: "comment.resolved", thread_id: thread, state: set_state })
      }
      return json({
        short_id,
        thread,
        ...(commentId ? { comment_id: commentId, anchored_to: quote ?? null } : {}),
        ...(reactedTo ? { reacted: react, reacted_to: reactedTo } : {}),
        ...(set_state ? { state: set_state } : {}),
        note: body
          ? reply_to
            ? "Replied in the thread."
            : "New comment thread created."
          : reactedTo
            ? `Acknowledged with ${react}.`
            : `Thread ${set_state}.`,
      })
    },
  )
}
