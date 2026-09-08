import {
  type ArtifactRecord,
  assertedOnly,
  type CommentRecord,
  diffLines,
  factDeltas,
  formatDiff,
  LINKED_BUNDLE_CONTENT_TYPE,
  type ReviewRoundRecord,
  toMarkdown,
  type VersionDataRecord,
  type VersionRecord,
  type WorkflowRunRecord,
} from "@derive/core"
import { z } from "zod"
import { localArtifactScanActivity } from "../lib/artifact-scan"
import {
  type ChangedParts,
  changedPartsWithReceipt,
  getChangedPartsReceipt,
} from "../lib/changed-parts"
import { clip } from "../lib/clip"
import { workflowActivitySuggestionsForRuns } from "../lib/workflow-activity"
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
        "START HERE on an artifact: versions, feedback, review, local scan activity, and possible missing workflow artifact receipts. WITHOUT a short_id, your WORK QUEUE. `wait` long-polls instead of sleeping. See derive://skills/loop and derive://skills/workflows.",
      // Genuinely read-only now: the queue's write half moved to `clear_queue`. The hint
      // was true-with-an-asterisk while `ack` lived here, kept that way so planning-mode
      // clients don't gate the start-here call on approval. That goal is unchanged and
      // now honestly met — nothing under this handler writes.
      annotations: {
        title: "Catch up on changes",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        short_id: z
          .string()
          .optional()
          .describe("The artifact to catch up on. Omit it to pull your work queue instead."),
        since_version: z.coerce.number().optional(),
        to_version: z.coerce.number().optional(),
        comments: z
          .enum(["open", "resolved", "outdated"])
          .optional()
          .describe(
            "Return ONLY this state's comment threads (the feedback queue) instead of the delta.",
          ),
        response_format: z
          .enum(["summary", "detailed", "parts"])
          .optional()
          .describe("summary (default) | detailed | parts."),
        wait: z.coerce
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Long-poll: block up to this many seconds (max 50) for the human's next action, instead of sleeping between polls.",
          ),
        workspace: wsArg,
      },
    },
    async ({ short_id, since_version, to_version, comments, response_format, wait, workspace }) => {
      // No short_id ⇒ the WORK QUEUE mode (absorbs the former check_requests): the
      // @mention inbox and its own request.created long-poll. Reading only — clearing
      // handled items is `clear_queue`.
      if (!short_id) return workQueue(undefined, wait)
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
            ["review.sent_back", "comment.created", "comment.updated", "version.published"],
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
        // applies to the current head). A stale sent_back from an older version
        // never disables the long-poll — the agent already consumed it.
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
      // These rows are independent once reach has authorized the artifact. Fetch them in
      // one latency wave instead of paying four serial edge round trips before the response
      // can be assembled. Stores keep the same methods and response contract.
      const snapshot = ctx.meta.catchUpRead ? await ctx.meta.catchUpRead(a.id, since, to) : null
      const [history, allComments, rounds, dataRows, workflowRuns]: [
        VersionRecord[],
        CommentRecord[],
        ReviewRoundRecord[],
        [VersionDataRecord[], VersionDataRecord[]],
        WorkflowRunRecord[],
      ] = snapshot
        ? [
            snapshot.versions,
            snapshot.comments,
            snapshot.rounds,
            [snapshot.beforeData, snapshot.afterData],
            snapshot.workflowRuns ?? [],
          ]
        : await Promise.all([
            ctx.meta.listVersions(a.id),
            ctx.meta.listComments(a.id),
            ctx.meta.listReviewRounds(a.id),
            since < to
              ? Promise.all([
                  ctx.meta.getVersionData(a.id, since).catch(() => []),
                  ctx.meta.getVersionData(a.id, to).catch(() => []),
                ])
              : Promise.resolve<[VersionDataRecord[], VersionDataRecord[]]>([[], []]),
            ctx.meta.listWorkflowRuns(a.id, a.org_id, { limit: 10 }),
          ])
      const newVersions = history.filter((v) => v.n > since && v.n <= to)
      // listVersions already returned every immutable version row. Re-fetching the two
      // selected rows paid two strictly serial edge round trips for data in hand.
      const vs = history.find((v) => v.n === since) ?? null
      const vh = history.find((v) => v.n === to) ?? null
      let entryDiff: string | null = null
      let partChanges: ChangedParts | null =
        response_format === "parts" && since >= to
          ? { count: 0, changes: [], note: "No newer version to compare." }
          : null
      let pagesChanged: ReturnType<typeof bundleFileChanges> | null = null
      if (vs && vh && since < to) {
        const [ms, mh] = await Promise.all([manifestOf(ctx, vs), manifestOf(ctx, vh)])
        if (ms && mh) pagesChanged = bundleFileChanges(ms, mh)
        if (response_format === "detailed") {
          const [as_, ah] = await Promise.all([ctx.sourceText(vs), ctx.sourceText(vh)])
          if (as_ !== null && ah !== null) {
            // Diff the READABLE form, not raw source: HTML tag noise drowns a
            // real change, and minified one-line HTML produces one useless
            // del/add pair. Markdown conversion re-introduces line structure so
            // the diff answers what an agent actually asks — what changed.
            const md = diffLines(toMarkdown(as_, vs.content_type), toMarkdown(ah, vh.content_type))
            entryDiff = `diff of markdown conversion (semantic view):\n\n${clip(formatDiff(md))}`
          }
        } else if (response_format === "parts") {
          if (ms || mh) {
            partChanges = {
              count: 0,
              changes: [],
              note: "Bundles report changed page paths in pages_changed. Read only those pages.",
            }
          } else {
            const beforeType = vs.content_type ?? "text/html"
            const afterType = vh.content_type ?? "text/html"
            partChanges = getChangedPartsReceipt(vs.blob_key, beforeType, vh.blob_key, afterType)
            if (!partChanges) {
              const [as_, ah] = await Promise.all([ctx.sourceText(vs), ctx.sourceText(vh)])
              if (as_ !== null && ah !== null) {
                try {
                  partChanges = changedPartsWithReceipt(
                    vs.blob_key,
                    as_,
                    beforeType,
                    vh.blob_key,
                    ah,
                    afterType,
                  )
                } catch {
                  partChanges = {
                    count: 0,
                    changes: [],
                    note: "These versions could not be mapped into stable document parts. Use response_format:'detailed' for the line diff.",
                  }
                }
              } else {
                partChanges = {
                  count: 0,
                  changes: [],
                  note: "One selected version has no readable source. Use the version history to choose another range.",
                }
              }
            }
          }
        }
      }
      if (response_format === "parts" && !partChanges)
        partChanges = {
          count: 0,
          changes: [],
          note: "One selected version is unavailable. Use the version history to choose another range.",
        }
      // ONE read of this artifact's comments, split by state in memory. These were three
      // separate `listComments(a.id, { state })` calls differing only by the filter — three
      // ~80ms round trips (see edge-pg.ts) on the agent loop's hottest call, for rows out of
      // the same table for the same artifact. `listComments` orders by created_at either
      // way, so each filtered slice keeps the order its own query produced.
      const open = allComments.filter((cm) => cm.state === "open")
      // Threads whose quoted text changed in a landed version — feedback that may no
      // longer apply. Surfacing it tells the agent its edits touched commented text.
      const outdated = allComments.filter((cm) => cm.state === "outdated")
      const outdatedBit = outdated.length
        ? ` ${outdated.length} now outdated (the quoted text changed).`
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
      // returned answers — read the open threads and their note; a note that reads
      // "good to go" is the go-signal.
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
      // The round's NOTE rides the summary, not just the JSON: it is where the human says
      // "keep going" or "good to go", and a model reading only the summary must see it.
      const noteBit = review?.note ? ` Their note: "${review.note}"` : ""
      const reviewBit = review
        ? review.state === "pending"
          ? ` Review requested on v${review.version} — waiting for the human.`
          : ` The human sent back their review of v${review.version} — read the open threads and their note, then revise and re-request, or stop if the note says it's good.${noteBit}`
        : ""
      const workflowReadability = new Map<string, Promise<boolean>>()
      const workflowFacts = new Map<number, Promise<VersionDataRecord[]>>()
      const loadWorkflowFacts = (version: number): Promise<VersionDataRecord[]> => {
        const existing = workflowFacts.get(version)
        if (existing) return existing
        const result = ctx.meta.getVersionData(a.id, version)
        workflowFacts.set(version, result)
        return result
      }
      const canReadWorkflowArtifact = (candidate: ArtifactRecord): Promise<boolean> => {
        const existing = workflowReadability.get(candidate.id)
        if (existing) return existing
        const result = reach(candidate.short_id, workspace, { artifact: candidate }).then(
          (reached) => Boolean(reached && !("error" in reached)),
        )
        workflowReadability.set(candidate.id, result)
        return result
      }
      const workflowRunIds = workflowRuns.map((run) => run.id)
      const [workflowAttempts, workflowActivity] =
        workflowRunIds.length > 0
          ? await Promise.all([
              ctx.meta.listWorkflowStepAttempts(workflowRunIds, a.org_id),
              ctx.meta.listWorkflowArtifactActivity(workflowRunIds, a.org_id),
            ])
          : [[], []]
      const workflowSuggestions = await workflowActivitySuggestionsForRuns({
        meta: ctx.meta,
        workflowArtifact: a,
        states: workflowRuns.map((run) => ({
          run,
          attempts: workflowAttempts.filter((item) => item.workflow_run_id === run.id),
          recorded: workflowActivity.filter((item) => item.workflow_run_id === run.id),
        })),
        canRead: canReadWorkflowArtifact,
        loadVersionData: loadWorkflowFacts,
      })
      const receiptGaps = workflowRuns
        .map((run) => {
          const suggestions = workflowSuggestions.get(run.id) ?? []
          if (suggestions.length === 0) return null
          return {
            run_id: run.id,
            diagram_id: run.diagram_id,
            run_status: run.status,
            suggestions: suggestions.map((suggestion) => ({
              artifact: {
                short_id: suggestion.artifactShortId,
                version: suggestion.artifactVersion,
                title: suggestion.artifactTitle,
              },
              node_id: suggestion.nodeId,
              attempt: suggestion.attempt,
              role: suggestion.role,
              reason: suggestion.reason,
              ...(suggestion.nodeId
                ? {
                    dismiss_with: {
                      tool: "use",
                      workflow_run: {
                        action: "dismiss",
                        run_id: run.id,
                        node_id: suggestion.nodeId,
                        artifact: {
                          short_id: suggestion.artifactShortId,
                          version: suggestion.artifactVersion,
                          role: suggestion.role,
                        },
                      },
                    },
                  }
                : {}),
              ...(suggestion.nodeId && suggestion.attempt
                ? {
                    confirm_with: {
                      tool: "use",
                      workflow: {
                        run_id: run.id,
                        node_id: suggestion.nodeId,
                        attempt: suggestion.attempt,
                        artifact: {
                          short_id: suggestion.artifactShortId,
                          version: suggestion.artifactVersion,
                          role: suggestion.role,
                        },
                      },
                    },
                  }
                : {
                    confirm_template: {
                      tool: "use",
                      known: {
                        run_id: run.id,
                        node_id: suggestion.nodeId,
                        artifact: {
                          short_id: suggestion.artifactShortId,
                          version: suggestion.artifactVersion,
                          role: suggestion.role,
                        },
                      },
                      missing: [
                        ...(suggestion.nodeId ? [] : ["node_id"]),
                        ...(suggestion.attempt ? [] : ["attempt"]),
                      ],
                      note: "Resolve the missing fields before you call use.",
                    },
                  }),
            })),
          }
        })
        .filter((item) => item !== null)
      const receiptGapCount = receiptGaps.reduce(
        (total, item) => total + item.suggestions.length,
        0,
      )
      const receiptBit = receiptGapCount
        ? ` ${receiptGapCount} possible workflow artifact receipt${receiptGapCount === 1 ? "" : "s"} need confirmation.`
        : ""
      const localScan =
        a.current_content_type === LINKED_BUNDLE_CONTENT_TYPE
          ? await localArtifactScanActivity({
              meta: ctx.meta,
              artifact: a,
              canRead: canReadWorkflowArtifact,
            })
          : { activity: [], related: [] }
      const localScanBit = localScan.related.length
        ? ` A local agent session published ${localScan.related.length} artifact${localScan.related.length === 1 ? "" : "s"} after reading this bundle.`
        : ""
      const summary =
        since >= to
          ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment${open.length === 1 ? "" : "s"}.${outdatedBit}${reviewBit}${receiptBit}${localScanBit}`
          : `"${a.title}": ${newVersions.length} new version${newVersions.length === 1 ? "" : "s"} since v${since} (now v${to}).${pageBits} ${open.length} open comment${open.length === 1 ? "" : "s"}.${outdatedBit}${reviewBit}${receiptBit}${localScanBit}`
      // What the NUMBERS did between the versions being compared. The prose diff already
      // shows what the page says; without this a review round sees everything except the
      // figures the page is about.
      const slotChanges =
        since < to
          ? // assertedOnly on both sides: "$stats.words 1204 -> 1288" is noise beside
            // "checks.pass 41 -> 44", and the diff exists to show the AUTHOR's numbers move.
            factDeltas(assertedOnly(dataRows[0]), assertedOnly(dataRows[1]))
          : []
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
        ...(slotChanges.length ? { data_changes: slotChanges } : {}),
        ...(partChanges ? { changed_parts: partChanges } : {}),
        open_comments: open.map(summarizeComment),
        ...(outdated.length ? { outdated_comments: outdated.map(summarizeComment) } : {}),
        ...(receiptGaps.length
          ? {
              workflow_receipt_gaps: receiptGaps,
              workflow_receipt_note:
                "These are permission-checked candidates, not completed steps. Confirm only exact versions that belong to the run.",
            }
          : {}),
        ...(localScan.activity.length || localScan.related.length
          ? {
              local_agent_activity: localScan,
              local_agent_activity_note:
                "These are privacy-safe local log observations. Same-session order suggests where to look, but it does not create a run, attach an artifact, or mark a node complete.",
            }
          : {}),
      })
    },
  )
}
