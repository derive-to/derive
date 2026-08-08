import { newId, roleAllows } from "@derive/core"
import { z } from "zod"
import { commentCreatedAction } from "../lib/comment-actions"
import { parseMeta, REACTIONS } from "../lib/comments"
import { resolveThreadAction } from "../lib/thread-actions"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

export function registerCommentTool(tc: ToolContext): void {
  const { server, ctx, agent, ownerId, reach, notFound, wsArg } = tc

  // COMMENT — leave / reply / resolve feedback --------------------------------
  server.registerTool(
    "comment",
    {
      description:
        "Give or resolve feedback on an artifact. `quote` anchors a NEW thread to exact rendered text; `reply_to` replies, reacts, or resolves an existing one. See derive://skills/loop.",
      // Writes (comments, reactions, thread state) but nothing here deletes: a comment
      // once posted stays, and set_state's resolve/reopen is explicitly reversible either
      // way. The Slack/webhook/email fan-out is a best-effort side notification, not the
      // tool's own domain (Derive's comment threads).
      annotations: {
        title: "Comment and review",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        short_id: z.string(),
        body: z.string().optional(),
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
          .describe("React to the thread's latest comment by someone else (with `reply_to`)."),
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
        // The SAME fan-out the HTTP route runs (lib/comment-actions.ts): bells for thread
        // participants + the artifact's owners, plus webhooks, email, and the GitHub and Slack
        // mirrors. This path used to bell only, so an agent's comment reached no channel at
        // all. The `comment` tool has no mentions of its own, so it passes none.
        const created = await ctx.meta.getComment(commentId)
        // Through ctx.background, exactly as the HTTP route runs it: the fan-out is
        // best-effort, and the comment is already durable by now. Awaiting it bare would turn
        // any channel-side failure (a Slack install lookup, a blob read for the GitHub diff)
        // into a tool error for a comment that WAS written — and an agent that believes its
        // comment failed retries and duplicates it. background() catches + logs, and on
        // Workers rides waitUntil; on Node it still settles inline.
        if (created)
          await ctx.background(
            commentCreatedAction(
              {
                meta: ctx.meta,
                bus: ctx.bus,
                blobs: ctx.blobs,
                baseUrl: ctx.deps.baseUrl,
                notify: ctx.notify,
                pokeWebhooks: ctx.deps.pokeWebhooks,
              },
              a,
              created,
              { mentions: [], actorId: agent.id, onBehalfOf: ownerId },
            ),
          )
      }
      // The ack: land the emoji on the thread's newest comment by someone ELSE
      // (the human being acknowledged), falling back to its newest comment.
      // Idempotent — re-acking never toggles the reaction off.
      let reactedTo: string | undefined
      if (react) {
        if (!thread) return err("`react` needs `reply_to` (the thread to acknowledge).")
        const inThread = (await ctx.meta.listComments(a.id, { threadId: thread })).filter(
          (c) => !parseMeta(c.meta).deleted,
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
        // The HTTP resolve route 404s on a thread that isn't on this artifact; this path has to
        // check too, because resolveThreadAction discards its update count and fans
        // comment.resolved out regardless. Without it an agent could emit unbounded "a thread was
        // resolved" events — into every webhook subscriber and any connected Slack channel — for
        // threads that never existed.
        const known = (await ctx.meta.listComments(a.id, { threadId: thread })).length > 0
        if (!known) return err(`No thread "${thread}" on "${short_id}".`)
        // Shared with the HTTP resolve route and the Slack Resolve button (lib/thread-actions.ts)
        // — it flips the thread, publishes on the bus AND fans comment.resolved out to webhooks.
        // The hand-rolled pair of calls this replaced skipped that last step.
        await resolveThreadAction(
          { meta: ctx.meta, bus: ctx.bus, notify: ctx.notify, baseUrl: ctx.deps.baseUrl },
          a,
          thread,
          set_state,
          agent.name,
        )
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
