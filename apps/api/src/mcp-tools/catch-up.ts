import { diffLines, formatDiff, toMarkdown } from "@derive/core"
import { z } from "zod"
import { clip } from "../lib/clip"
import type { ToolContext } from "../mcp-tool-context"
import {
  bundleFileChanges,
  changeCount,
  err,
  json,
  manifestOf,
  summarizeComment,
  summarizeVersion,
} from "../mcp-util"

export function registerCatchUpTool(tc: ToolContext): void {
  const { server, ctx, agent, reach, notFound, workQueue, wsArg } = tc

  // CATCH UP — state, feedback, history, and diffs all in one ------------------
  server.registerTool(
    "catch_up",
    {
      description:
        "With a `short_id`: START HERE on an artifact — its state in one call: a one-line summary, the versions that landed since `since_version`, which pages changed, the open (and outdated) comment threads, the review round you're waiting on, and the full version history. Pass `comments` (open/addressed/resolved/outdated) for that filtered thread list instead — your feedback to-do queue. Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) for a line-by-line diff of the two versions' readable Markdown form. WITHOUT a short_id: your WORK QUEUE — pending requests teammates handed you by @mentioning you in a comment (the ask-agent and Rework buttons); pass `ack:[id,…]` to clear the ones you finished. WAITING ON SOMETHING? Pass `wait` (seconds, max 50) to block until the human acts (or, in queue mode, until new work lands), then return the fresh state — chain waits instead of sleeping between polls. For the diff, review states, working a request, and the wait loop, read derive://skills/loop.",
      // Read-only except `ack`, which clears handled requests off the queue. The hint
      // stays true so planning-mode clients don't gate the start-here call on approval.
      annotations: { readOnlyHint: true },
      inputSchema: {
        short_id: z
          .string()
          .optional()
          .describe("The artifact to catch up on. Omit it to pull your work queue instead."),
        ack: z
          .array(z.string())
          .optional()
          .describe(
            "Work-queue mode (no short_id): request ids you have HANDLED — acknowledges them off the queue. Ack after the work lands (a publish or a reply), not on read; an unknown or already-acked id is skipped, never an error.",
          ),
        since_version: z.coerce
          .number()
          .optional()
          .describe("The version you last saw (the diff base). Defaults to to_version − 1."),
        to_version: z.coerce
          .number()
          .optional()
          .describe("Compare up to this version instead of the current one (for an exact diff)."),
        comments: z
          .enum(["open", "addressed", "resolved", "outdated"])
          .optional()
          .describe(
            "Return ONLY this state's comment threads (the feedback queue) instead of the delta.",
          ),
        response_format: z
          .enum(["summary", "detailed"])
          .optional()
          .describe(
            "'summary' (default, token-light) omits the line diff; 'detailed' includes it.",
          ),
        wait: z.coerce
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Long-poll: block up to this many seconds for the human's next action (send back, approve, a new comment, or a new published version — e.g. co-editing the artifact live) before returning. Returns immediately when something is already actionable.",
          ),
        workspace: wsArg,
      },
    },
    async ({
      short_id,
      ack,
      since_version,
      to_version,
      comments,
      response_format,
      wait,
      workspace,
    }) => {
      // No short_id ⇒ the WORK QUEUE mode (absorbs the former check_requests): the
      // @mention inbox, its ack, and its own request.created long-poll.
      if (!short_id) return workQueue(ack, wait)
      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      let a = r.a

      // Long-poll: when the agent is waiting on the human, block on the artifact
      // channel until they act, then fall through and build the response fresh
      // (composes with the `comments` filter below — wait, then the queue). The
      // event is only a wake signal — all state below is re-read from the store,
      // so a missed or raced event can never produce a wrong answer. The
      // subscription starts BEFORE the state check, so an action landing in that
      // gap wakes us instead of slipping through; when something is already
      // actionable the wait is released immediately.
      if (wait && ctx.bus.waitFor) {
        const release = new AbortController()
        const waited = ctx.bus
          .waitFor(
            a.id,
            [
              "review.sent_back",
              "review.approved",
              "comment.created",
              "comment.updated",
              "version.published",
            ],
            wait * 1000,
            release.signal,
          )
          .catch(() => null)
        const rounds = await ctx.meta.listReviewRounds(a.id)
        const round =
          rounds.find((r) => r.state === "pending") ??
          rounds.find((r) => r.requested_by === agent.id) ??
          rounds[0] ??
          null
        // Actionable = a settled decision the agent hasn't built on yet (it still
        // applies to the current head). A stale sent_back/approved from an older
        // version never disables the long-poll — the agent already consumed it.
        const actionable = round && round.state !== "pending" && round.version >= a.current_version
        if (actionable) {
          release.abort()
          await waited
        } else {
          await waited
          // Refresh: the head (or the artifact itself) may have moved while waiting.
          const rr = await reach(short_id, workspace)
          a = rr && !("error" in rr) ? rr.a : a
        }
      }

      // `comments` filter → the feedback to-do queue (absorbs the old list_comments).
      if (comments) {
        const list = await ctx.meta.listComments(a.id, { state: comments })
        return json({
          short_id,
          comments_state: comments,
          count: list.length,
          comments: list.map(summarizeComment),
        })
      }

      const head = a.current_version
      const to = Math.min(head, Math.max(1, to_version ?? head))
      const since = Math.min(to, Math.max(1, since_version ?? to - 1))
      const history = await ctx.meta.listVersions(a.id)
      const newVersions = history.filter((v) => v.n > since && v.n <= to)
      const vs = await ctx.meta.getVersion(a.id, since)
      const vh = await ctx.meta.getVersion(a.id, to)
      let entryDiff: string | null = null
      let pagesChanged: ReturnType<typeof bundleFileChanges> | null = null
      if (vs && vh && since < to) {
        const [ms, mh] = [await manifestOf(ctx, vs), await manifestOf(ctx, vh)]
        if (ms && mh) pagesChanged = bundleFileChanges(ms, mh)
        if (response_format === "detailed") {
          const [as_, ah] = [await ctx.sourceText(vs), await ctx.sourceText(vh)]
          if (as_ !== null && ah !== null) {
            // Diff the READABLE form, not raw source: HTML tag noise drowns a
            // real change, and minified one-line HTML produces one useless
            // del/add pair. Markdown conversion re-introduces line structure so
            // the diff answers what an agent actually asks — what changed.
            const md = diffLines(toMarkdown(as_, vs.content_type), toMarkdown(ah, vh.content_type))
            entryDiff = `diff of markdown conversion (semantic view):\n\n${clip(formatDiff(md))}`
          }
        }
      }
      // ONE read of this artifact's comments, split by state in memory. These were three
      // separate `listComments(a.id, { state })` calls differing only by the filter — three
      // ~80ms round trips (see edge-pg.ts) on the agent loop's hottest call, for rows out of
      // the same table for the same artifact. `listComments` orders by created_at either
      // way, so each filtered slice keeps the order its own query produced.
      const allComments = await ctx.meta.listComments(a.id)
      const open = allComments.filter((cm) => cm.state === "open")
      // Threads whose quoted text changed in a landed version — feedback that may no
      // longer apply. Surfacing it tells the agent its edits touched commented text.
      const outdated = allComments.filter((cm) => cm.state === "outdated")
      const outdatedBit = outdated.length
        ? ` ${outdated.length} now outdated (the quoted text changed).`
        : ""
      // Threads with a proposal already pending — the agent shouldn't re-address them.
      const addressed = allComments.filter((cm) => cm.state === "addressed")
      const addressedBit = addressed.length
        ? ` ${addressed.length} addressed (a proposal is pending review).`
        : ""
      const pageBits =
        pagesChanged && changeCount(pagesChanged)
          ? ` Pages: ${[
              pagesChanged.added.length && `+${pagesChanged.added.length}`,
              pagesChanged.changed.length && `~${pagesChanged.changed.length}`,
              pagesChanged.removed.length && `-${pagesChanged.removed.length}`,
            ]
              .filter(Boolean)
              .join(" ")}.`
          : ""
      // The review round this agent is waiting on (the loop's poll target): the round
      // it requested most recently. `pending` = still waiting; `sent_back` = the human
      // returned answers — read the open threads and revise; `approved` = the go-signal.
      const rounds = await ctx.meta.listReviewRounds(a.id)
      const myRound =
        rounds.find((r) => r.state === "pending") ??
        rounds.find((r) => r.requested_by === agent.id) ??
        rounds[0] ??
        null
      const review = myRound
        ? {
            state: myRound.state,
            version: myRound.version,
            requested_at: myRound.created_at,
            resolved_at: myRound.resolved_at,
            note: myRound.note,
          }
        : null
      const reviewBit = review
        ? review.state === "pending"
          ? ` Review requested on v${review.version} — waiting for the human.`
          : review.state === "sent_back"
            ? ` The human sent back their review of v${review.version} — read the open threads, revise, and re-request.`
            : ` The human approved v${review.version} — you're clear to proceed.`
        : ""
      const summary =
        since >= to
          ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}${reviewBit}`
          : `"${a.title}": ${newVersions.length} new version${newVersions.length === 1 ? "" : "s"} since v${since} (now v${to}).${pageBits} ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}${reviewBit}`
      return json({
        summary,
        review,
        short_id,
        since,
        to,
        head,
        caught_up: since >= to,
        versions: history.slice().reverse().map(summarizeVersion),
        new_versions: newVersions.map(summarizeVersion),
        pages_changed: pagesChanged,
        ...(entryDiff
          ? { entry_diff: entryDiff }
          : {
              entry_diff:
                "(omitted) — call again with response_format='detailed' for the line-level changes.",
            }),
        open_comments: open.map(summarizeComment),
        ...(outdated.length ? { outdated_comments: outdated.map(summarizeComment) } : {}),
      })
    },
  )
}
