import {
  type ContextRecord,
  newId,
  roleAllows,
  type SessionRecord,
  workflowStatusIsTerminal,
} from "@derive/core"
import { z } from "zod"
import { metaForWire } from "../lib/context-builder-card"
import { IMPORTED_NO_RUNS } from "../lib/context-package"
import { canPayForAgent, NO_PAYER_MESSAGE } from "../lib/payer"
import { loadWorkflowRunArtifactState } from "../lib/workflow-activity"
import {
  bindWorkflowContextSession,
  prepareWorkflowContextUse,
  recordWorkflowArtifact,
  recordWorkflowReceipt,
  startLocalWorkflowRun,
  syncWorkflowContextSession,
} from "../lib/workflow-coordination"
import type { ToolContext } from "../mcp-tool-context"
import { ANSWER_MAX, clipSessionText, ENTRY_MAX, err, json, runnerOnline } from "../mcp-util"
import { ownerRunsOrg, runnerDispatch } from "./use-runner"

// USE A CONTEXT — query a workspace's live data agents ------------------------
// Ordinary calls act for the connection's human and are limited by that person's live
// context grant. A registered agent assigned to a workflow run acts for the run's human
// initiator, preserving the same grant and payer checks. Discovery remains on `find`;
// context management remains on `automate` and REST.

const NO_HUMAN =
  "Using a Context opens a session on a human's behalf, and this connection has no acting human. " +
  "Reconnect with an OAuth login (or a token registered by a user) to use one."

const workflowInput = z.object({
  run_id: z.string().trim().min(1),
  node_id: z.string().trim().min(1),
  attempt: z.coerce.number().int().min(1),
  status: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  decision: z.unknown().optional(),
  selected_routes: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  route_basis: z.string().trim().min(1).max(2_000).optional(),
  output: z.unknown().optional(),
  error: z.string().trim().min(1).max(20_000).optional(),
  finish_run: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  artifact: z
    .object({
      short_id: z.string().trim().min(1),
      version: z.coerce.number().int().min(1),
      role: z.enum(["output", "evidence", "input"]).default("output"),
    })
    .optional(),
})

const workflowRunInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    short_id: z.string().trim().min(1),
    diagram_id: z.string().trim().min(1).max(200),
    dedupe_key: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal("inspect"),
    run_id: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("list"),
    short_id: z.string().trim().min(1),
    diagram_id: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  z.object({
    action: z.literal("cancel"),
    run_id: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("dismiss"),
    run_id: z.string().trim().min(1),
    node_id: z.string().trim().min(1),
    artifact: z.object({
      short_id: z.string().trim().min(1),
      version: z.coerce.number().int().min(1),
      role: z.enum(["output", "evidence", "input"]),
    }),
  }),
])

const parseSelectedRoutes = (value: string | null): string[] | null => {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((route) => typeof route === "string")
      ? parsed
      : null
  } catch {
    return null
  }
}

export function registerUseTool(tc: ToolContext): void {
  const {
    server,
    ctx,
    agent,
    actingFor,
    registered,
    askableContexts,
    inGrant,
    resolveWs,
    reach,
    wsArg,
    workflowScope,
  } = tc

  // (Listing the askable contexts now lives in `find` — they ride the browse/search rows.)

  server.registerTool(
    "use",
    {
      description:
        "Use Contexts or workflow runs. `workflow_run` manages runs. `workflow` binds attempts, records receipts, or attaches exact versions. See derive://skills/contexts and derive://skills/workflows.",
      // Opens/advances a session (a write — messages accumulate, budget is spent) but
      // deletes nothing; a session can be followed up or checked, never destroyed from
      // here. Not idempotent by default (each open mints a new session — `dedupe_key` is
      // the opt-in exception, not the norm). This call's own execution only creates rows
      // and waits on Derive's internal bus; it doesn't itself reach outside Derive.
      annotations: {
        title: "Run with a workspace Context",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe("The Context id or name from find. Opens a NEW session; omit with session_id."),
        instruction: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            "'With this Context, do this' (Markdown) — a question or a task, always naming the target.",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "An existing session of yours (from an earlier use, or a find context row) to follow up on or check.",
          ),
        wait: z.coerce
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Seconds to wait for a tick or the answer (default 25; 0 returns at once)."),
        dedupe_key: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "OPEN mode: an idempotency key — a second use with the same key JOINS the in-flight session.",
          ),
        answer: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe("RUN mode: your reply on a session you run."),
        progress: z
          .boolean()
          .optional()
          .describe(
            "RUN mode: a non-settling progress tick; streams `answer` without ending the session.",
          ),
        state: z
          .enum(["answered", "escalated", "failed"])
          .optional()
          .describe("RUN mode: the terminal state. Omit for a plain answered result."),
        result_artifact_id: z
          .string()
          .optional()
          .describe(
            "RUN mode: the session's result artifact short_id — the stable link the requester sees.",
          ),
        answers: z
          .string()
          .optional()
          .describe("RUN mode: the requester-message id this addresses."),
        workflow: workflowInput
          .optional()
          .describe("Bind a run attempt, record its receipt, or attach an artifact version."),
        workflow_run: workflowRunInput.optional().describe("Manage a workflow run."),
        workspace: wsArg,
      },
    },
    async ({
      context,
      instruction,
      session_id,
      wait,
      dedupe_key,
      answer,
      progress,
      state,
      result_artifact_id,
      answers,
      workflow,
      workflow_run,
      workspace,
    }) => {
      if (
        workflow_run &&
        (workflow ||
          context ||
          session_id ||
          instruction ||
          answer ||
          progress !== undefined ||
          state ||
          result_artifact_id ||
          answers ||
          dedupe_key ||
          wait !== undefined)
      )
        return err("Manage a workflow run without Context, receipt, or runner fields.")
      if (workflowScope) {
        if (answer || progress !== undefined || state || result_artifact_id || answers)
          return err("This workflow capability cannot run or answer Context sessions.")
        if (workflow_run?.action === "start" || workflow_run?.action === "list")
          return err("This workflow capability cannot start or list workflow runs.")
        if (
          (workflow_run?.action === "inspect" ||
            workflow_run?.action === "cancel" ||
            workflow_run?.action === "dismiss") &&
          workflow_run.run_id !== workflowScope
        )
          return err("This workflow capability is scoped to a different run.")
        if (workflow && workflow.run_id !== workflowScope)
          return err("This workflow capability is scoped to a different run.")
        if (session_id) {
          if (context || dedupe_key || workflow)
            return err(
              "A workflow capability may only continue or check its already-bound Context session.",
            )
          const attempt = await ctx.meta.getWorkflowStepAttemptBySession(session_id, agent.org_id)
          if (!attempt || attempt.workflow_run_id !== workflowScope)
            return err("This Context session is not bound to the scoped workflow run.")
        } else if (
          (!workflow || workflow.run_id !== workflowScope) &&
          ((workflow_run?.action !== "inspect" &&
            workflow_run?.action !== "cancel" &&
            workflow_run?.action !== "dismiss") ||
            workflow_run.run_id !== workflowScope)
        ) {
          return err("This workflow capability must name its assigned workflow run.")
        }
      }
      // RUN MODE — dispatched by ownership: a registered agent on a context it is the
      // AGENT FOR (needs no acting human — it acts as itself), or OWNER-RUN, a grant
      // whose human holds the owner seat in the context's workspace. runnerDispatch
      // handles REPORT/PULL and returns a result, or null when this isn't a runner op,
      // so it falls through to the give path below and every other grant's surface is
      // unchanged. (See mcp-tools/use-runner.ts.)
      if (!workflowScope) {
        const ran = await runnerDispatch(tc, {
          context,
          instruction,
          session_id,
          answer,
          progress,
          state,
          result_artifact_id,
          answers,
          workspace,
        })
        if (ran) return ran
      }
      const workflowPrincipal = async (runId: string, resolvedOrgId?: string) => {
        let orgId = resolvedOrgId
        if (!orgId) {
          const target = await resolveWs(workspace)
          if ("error" in target) return target.error
          orgId = target.org
        }
        const run = await ctx.meta.getWorkflowRun(runId, orgId)
        if (!run) return "No such workflow run in this workspace."
        const ownsManualRun = !!actingFor && run.initiated_by === actingFor.id
        const isAssignedAgent = registered && run.assigned_agent_id === agent.id
        if (!ownsManualRun && !isAssignedAgent)
          return "This connection is not the executor assigned to that workflow run."
        if (!run.initiated_by)
          return "This workflow run has no human initiator to authorize contexts."
        return {
          run,
          orgId,
          askerId: run.initiated_by,
          executorId: isAssignedAgent ? agent.id : run.initiated_by,
        }
      }
      if (workflow_run?.action === "start") {
        if (!actingFor) return err(NO_HUMAN)
        const reached = await reach(workflow_run.short_id, workspace)
        if (reached && "error" in reached) return err(reached.error)
        if (!reached) return err(`No artifact "${workflow_run.short_id}" you can reach.`)
        if (!roleAllows(reached.role, "comment"))
          return err("Starting a workflow run requires comment access to the workflow artifact.")
        const started = await startLocalWorkflowRun({
          meta: ctx.meta,
          workflowArtifact: reached.a,
          diagramId: workflow_run.diagram_id,
          initiatorId: actingFor.id,
          assignedAgentId: registered ? agent.id : undefined,
          idempotencyKey: workflow_run.dedupe_key,
          baseUrl: ctx.deps.baseUrl,
          at: new Date().toISOString(),
        })
        if (typeof started === "string") return err(started)
        return json({
          workflow_run: {
            id: started.run.id,
            artifact: {
              short_id: reached.a.short_id,
              version: started.run.workflow_version,
            },
            diagram_id: started.run.diagram_id,
            status: started.run.status,
          },
          prompt: started.prompt,
          next: `Inspect receipts with use({workflow_run:{action:"inspect",run_id:"${started.run.id}"}}).`,
        })
      }
      if (workflow_run?.action === "list") {
        const reached = await reach(workflow_run.short_id, workspace)
        if (reached && "error" in reached) return err(reached.error)
        if (!reached) return err(`No artifact "${workflow_run.short_id}" you can reach.`)
        if (!roleAllows(reached.role, "comment"))
          return err("Listing workflow runs requires comment access to the workflow artifact.")
        const initiatedBy = actingFor?.id
        const assignedAgentId = registered ? agent.id : undefined
        const runs =
          initiatedBy || assignedAgentId
            ? await ctx.meta.listWorkflowRuns(reached.a.id, reached.org, {
                diagramId: workflow_run.diagram_id,
                initiatedBy,
                assignedAgentId,
                limit: workflow_run.limit,
              })
            : []
        return json({
          workflow_runs: runs.map((run) => ({
            id: run.id,
            artifact: { short_id: reached.a.short_id, version: run.workflow_version },
            diagram_id: run.diagram_id,
            status: run.status,
            reason: run.reason,
            created_at: run.created_at,
            started_at: run.started_at,
            finished_at: run.finished_at,
          })),
        })
      }
      if (workflow_run?.action === "cancel") {
        const principal = await workflowPrincipal(workflow_run.run_id)
        if (typeof principal === "string") return err(principal)
        let run = principal.run
        for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
          if (run.status === "cancelled")
            return json({ workflow_run_id: run.id, status: run.status })
          if (workflowStatusIsTerminal(run.status))
            return err(`Workflow run ${run.id} is already ${run.status}.`)
          const claimed = run.status === "running" || run.status === "waiting"
          if (claimed) {
            const attempts = await ctx.meta.listWorkflowStepAttempts(run.id, run.org_id)
            if (attempts.some((attempt) => !workflowStatusIsTerminal(attempt.status)))
              return err(
                "This run has an active attempt. Close or settle its Context session before cancellation.",
              )
          }
          const cancelled = await ctx.meta.transitionWorkflowRun(
            run.id,
            run.org_id,
            { status: run.status, stateRevision: run.state_revision },
            {
              status: "cancelled",
              at: new Date().toISOString(),
              ...(claimed && run.actual_execution && run.executor_id
                ? { actualExecution: run.actual_execution, executorId: run.executor_id }
                : {}),
            },
          )
          if (cancelled) return json({ workflow_run_id: cancelled.id, status: cancelled.status })
          const fresh = await ctx.meta.getWorkflowRun(run.id, run.org_id)
          if (!fresh) return err("The workflow run is unavailable.")
          run = fresh
        }
        return err("The workflow run changed while cancellation was recorded. Inspect and retry.")
      }
      if (workflow_run?.action === "dismiss") {
        const principal = await workflowPrincipal(workflow_run.run_id)
        if (typeof principal === "string") return err(principal)
        const recorded = await ctx.meta.listWorkflowArtifactActivity(
          principal.run.id,
          principal.run.org_id,
        )
        const existing = recorded.find(
          (item) =>
            item.source === "dismissed" &&
            item.node_id === workflow_run.node_id &&
            item.artifact_short_id === workflow_run.artifact.short_id &&
            item.artifact_version === workflow_run.artifact.version &&
            item.role === workflow_run.artifact.role,
        )
        if (existing)
          return json({
            workflow_run_id: principal.run.id,
            dismissal_id: existing.id,
            dismissed: true,
          })
        const workflowArtifact = await ctx.meta.getArtifactById(principal.run.workflow_artifact_id)
        if (!workflowArtifact) return err("The workflow artifact is unavailable.")
        const graphReach = await reach(workflowArtifact.short_id, workspace, {
          artifact: workflowArtifact,
        })
        if (!graphReach || "error" in graphReach)
          return err("The workflow artifact is unavailable to this connection.")
        const snapshot = await loadWorkflowRunArtifactState({
          meta: ctx.meta,
          workflowArtifact,
          run: principal.run,
          canRead: async (artifact) => {
            const candidate = await reach(artifact.short_id, workspace, { artifact })
            return !!candidate && !("error" in candidate)
          },
        })
        const suggestion = snapshot.suggestions.find(
          (item) =>
            item.nodeId === workflow_run.node_id &&
            item.artifactShortId === workflow_run.artifact.short_id &&
            item.artifactVersion === workflow_run.artifact.version &&
            item.role === workflow_run.artifact.role,
        )
        if (!suggestion) return err("No matching readable workflow suggestion to dismiss.")
        const dismissed = await ctx.meta.recordWorkflowArtifactActivity({
          id: newId("wfa"),
          org_id: principal.run.org_id,
          workflow_run_id: principal.run.id,
          node_id: suggestion.nodeId ?? workflow_run.node_id,
          attempt: 0,
          artifact_short_id: suggestion.artifactShortId,
          artifact_version: suggestion.artifactVersion,
          artifact_title: suggestion.artifactTitle,
          role: suggestion.role,
          source: "dismissed",
          created_at: new Date().toISOString(),
        })
        return json({
          workflow_run_id: principal.run.id,
          dismissal_id: dismissed.id,
          dismissed: true,
        })
      }
      if (workflow_run?.action === "inspect") {
        const principal = await workflowPrincipal(workflow_run.run_id)
        if (typeof principal === "string") return err(principal)
        const workflowArtifact = await ctx.meta.getArtifactById(principal.run.workflow_artifact_id)
        if (!workflowArtifact) return err("The workflow artifact is unavailable.")
        const graphReach = await reach(workflowArtifact.short_id, workspace, {
          artifact: workflowArtifact,
        })
        if (!graphReach || "error" in graphReach)
          return err("The workflow artifact is unavailable to this connection.")
        const snapshot = await loadWorkflowRunArtifactState({
          meta: ctx.meta,
          workflowArtifact,
          run: principal.run,
          canRead: async (artifact) => {
            const candidate = await reach(artifact.short_id, workspace, { artifact })
            return !!candidate && !("error" in candidate)
          },
        })
        return json({
          workflow_run: {
            id: principal.run.id,
            artifact: {
              short_id: workflowArtifact.short_id,
              version: principal.run.workflow_version,
            },
            diagram_id: principal.run.diagram_id,
            status: principal.run.status,
            reason: principal.run.reason,
            requested_execution: principal.run.requested_execution,
            actual_execution: principal.run.actual_execution,
            created_at: principal.run.created_at,
            started_at: principal.run.started_at,
            finished_at: principal.run.finished_at,
          },
          attempts: snapshot.attempts.map((attempt) => ({
            id: attempt.id,
            node_id: attempt.node_id,
            attempt: attempt.attempt,
            kind: attempt.kind,
            status: attempt.status,
            selected_routes: parseSelectedRoutes(attempt.selected_routes),
            route_basis: attempt.route_basis,
            result_artifact_id: attempt.result_artifact_id,
            error: attempt.error,
            created_at: attempt.created_at,
            started_at: attempt.started_at,
            finished_at: attempt.finished_at,
          })),
          activity: snapshot.activity.map((item) => ({
            id: item.id,
            node_id: item.node_id,
            attempt: item.attempt,
            artifact: {
              short_id: item.artifact_short_id,
              version: item.artifact_version,
              title: item.artifact_title,
            },
            role: item.role,
            source: item.source,
            created_at: item.created_at,
          })),
          suggestions: snapshot.suggestions.map((item) => ({
            artifact: {
              short_id: item.artifactShortId,
              version: item.artifactVersion,
              title: item.artifactTitle,
            },
            node_id: item.nodeId,
            attempt: item.attempt,
            role: item.role,
            reason: item.reason,
            created_at: item.createdAt,
            ...(item.nodeId
              ? {
                  dismiss_with: {
                    tool: "use",
                    workflow_run: {
                      action: "dismiss",
                      run_id: principal.run.id,
                      node_id: item.nodeId,
                      artifact: {
                        short_id: item.artifactShortId,
                        version: item.artifactVersion,
                        role: item.role,
                      },
                    },
                  },
                }
              : {}),
            ...(item.nodeId && item.attempt
              ? {
                  confirm_with: {
                    tool: "use",
                    workflow: {
                      run_id: principal.run.id,
                      node_id: item.nodeId,
                      attempt: item.attempt,
                      artifact: {
                        short_id: item.artifactShortId,
                        version: item.artifactVersion,
                        role: item.role,
                      },
                    },
                  },
                }
              : {
                  confirm_template: {
                    tool: "use",
                    known: {
                      run_id: principal.run.id,
                      node_id: item.nodeId,
                      artifact: {
                        short_id: item.artifactShortId,
                        version: item.artifactVersion,
                        role: item.role,
                      },
                    },
                    missing: [
                      ...(item.nodeId ? [] : ["node_id"]),
                      ...(item.attempt ? [] : ["attempt"]),
                    ],
                    note: "Resolve the missing fields before you call use.",
                  },
                }),
          })),
          note: "Activity records exact observed versions. Suggestions require confirmation and never complete a node.",
        })
      }
      if (
        workflow &&
        !workflow.status &&
        (workflow.decision !== undefined ||
          workflow.selected_routes !== undefined ||
          workflow.route_basis !== undefined ||
          workflow.output !== undefined ||
          workflow.error !== undefined ||
          workflow.finish_run !== undefined)
      )
        return err("Workflow receipt fields require `status`.")
      if (workflow?.artifact) {
        if (
          workflow.status ||
          context ||
          session_id ||
          instruction ||
          answer ||
          progress !== undefined ||
          state ||
          result_artifact_id ||
          answers ||
          dedupe_key ||
          wait !== undefined
        )
          return err("Attach workflow activity without receipt, Context, or runner fields.")
        const principal = await workflowPrincipal(workflow.run_id)
        if (typeof principal === "string") return err(principal)
        const artifact = await ctx.meta.getByShortId(workflow.artifact.short_id)
        if (!artifact || artifact.org_id !== principal.orgId)
          return err("No such readable artifact in this workflow's workspace.")
        const readable = await reach(artifact.short_id, workspace, { artifact })
        if (!readable || "error" in readable || readable.org !== principal.orgId)
          return err("No such readable artifact in this workflow's workspace.")
        const version = await ctx.meta.getVersion(artifact.id, workflow.artifact.version)
        if (!version) return err("No such artifact version.")
        const recorded = await recordWorkflowArtifact({
          meta: ctx.meta,
          ref: {
            run_id: workflow.run_id,
            node_id: workflow.node_id,
            attempt: workflow.attempt,
            role: workflow.artifact.role,
          },
          orgId: principal.orgId,
          artifact,
          version: version.n,
          at: new Date().toISOString(),
        })
        if (typeof recorded === "string") return err(recorded)
        return json({
          workflow_run_id: recorded.workflow_run_id,
          node_id: recorded.node_id,
          attempt: recorded.attempt,
          activity_id: recorded.id,
          artifact: recorded.artifact_short_id,
          version: recorded.artifact_version,
          role: recorded.role,
          completion: "unconfirmed",
        })
      }
      if (workflow?.status) {
        if (
          context ||
          session_id ||
          instruction ||
          answer ||
          progress !== undefined ||
          state ||
          result_artifact_id ||
          answers ||
          dedupe_key ||
          wait !== undefined
        )
          return err("Record a workflow receipt without context-session or runner fields.")
        const principal = await workflowPrincipal(workflow.run_id)
        if (typeof principal === "string") return err(principal)
        const recorded = await recordWorkflowReceipt({
          meta: ctx.meta,
          receipt: { ...workflow, status: workflow.status },
          orgId: principal.orgId,
          executorId: principal.executorId,
          executionLane: workflowScope ? "github_actions" : "local",
          at: new Date().toISOString(),
        })
        if (typeof recorded === "string") return err(recorded)
        return json({
          workflow_run_id: recorded.run.id,
          run_status: recorded.run.status,
          node_id: recorded.attempt.node_id,
          attempt: recorded.attempt.attempt,
          attempt_status: recorded.attempt.status,
        })
      }
      if (workflow && !context)
        return err(
          "Bind workflow run/node/attempt while opening its context, attach an artifact, or pass status to record a receipt.",
        )
      if (!actingFor && !workflow) return err(NO_HUMAN)
      // Session WRITES are capped per acting human — each one triggers a model
      // run on the context owner's runner, so a looping agent is the realistic
      // flood. The check mode is a read and stays uncapped.
      const overAskCap = async (askerId: string) => {
        if (!ctx.askLimiter) return null
        const r = await ctx.askLimiter(`id:${askerId}`)
        return r.ok ? null : err(`Rate limit exceeded — retry in ${r.retryAfter}s.`)
      }

      // Every mode ends here: wait out the runner while the session is NOT settled,
      // returning EARLY on a progress tick (a Maker job streams — don't block to
      // timeout), then shape the reply from a FRESH read. The event is only a wake,
      // so a missed/raced one is never a wrong answer. The channel wakes for ANY of
      // this human's sessions; the loop re-checks ours and waits out the remainder.
      const isSettled = (st: string) =>
        st === "answered" || st === "escalated" || st === "failed" || st === "closed"
      const reply = async (start: SessionRecord, x: ContextRecord, checkOnly: boolean) => {
        let s = start
        const deadline = Date.now() + Math.min(Math.max(wait ?? 25, 0), 50) * 1000
        while (!isSettled(s.state) && ctx.bus.waitFor) {
          const left = deadline - Date.now()
          if (left <= 0) break
          const release = new AbortController()
          const woke = ctx.bus
            .waitFor(
              `u:${s.asker_id}`,
              ["session.settled", "session.progress"],
              left,
              release.signal,
            )
            .catch(() => null)
          // Close the check-then-wait gap: a settle/progress may have landed since
          // the last read, before our subscription existed.
          const fresh = await ctx.meta.getSession(s.id)
          if (fresh) s = fresh
          if (isSettled(s.state)) {
            release.abort()
            await woke
            break
          }
          const e = await woke
          s = (await ctx.meta.getSession(s.id)) ?? s
          if (isSettled(s.state)) break
          if (!e) break // timed out — s holds one last fresh read
          // A progress tick for OUR session: return it now (the runner is streaming).
          // A wake for a different session loops and waits out the remainder.
          if (e.type === "session.progress" && e.session_id === s.id) break
        }

        await syncWorkflowContextSession(ctx.meta, s)
        const workflowAttempt = await ctx.meta.getWorkflowStepAttemptBySession(s.id, s.org_id)
        const transcript = await ctx.meta.listSessionMessages(s.id)
        const lastAgent = transcript.filter((m) => m.author_kind === "agent").at(-1)
        // The last agent message is the ANSWER once settled, or the latest PROGRESS
        // tick while `working`. Stored as TEXT (see ports); a hand-edited row must not
        // 500 the tool — unparseable meta reads as absent.
        const parseMeta = (row?: { meta: string | null }): unknown => metaForWire(row?.meta ?? null)
        const answerRow = isSettled(s.state) ? lastAgent : undefined
        const progressRow = s.state === "working" ? lastAgent : undefined
        const base = ctx.deps.baseUrl.replace(/\/$/, "")
        const consoleUrl = `${base}/contexts/${x.id}`
        // The living result artifact (a Maker binds a "building…" page early and
        // updates it as stages land) — a stable link from the first tick.
        const resultUrl = s.result_artifact_id
          ? `${base}/artifacts/${s.result_artifact_id}`
          : undefined
        // A queue with no live runner is a dead end for most askers — but its OWNER can
        // just serve it (owner-run), so steer them there instead of telling them to wait.
        // Registered agents keep the wait text: their bare use({context}) pull only
        // reaches contexts they are the agent for.
        const note =
          s.state === "open"
            ? runnerOnline(x)
              ? "Queued — re-call use with this session_id (+ wait) to collect the answer."
              : (await ownerRunsOrg(tc, x.org_id))
                ? `Queued, and no Agent is polling this Context's queue — but you own this workspace, so you can run it yourself: use({context: "${x.name}"}) with no instruction pulls the queued work (see derive://skills/contexts).`
                : "Queued, but this Context's Agent looks OFFLINE — it answers when it comes back. Re-call use with this session_id later."
            : s.state === "working"
              ? "In progress — the runner is working. Re-call use with this session_id (+ wait) to keep watching; the result link fills in as it goes."
              : s.state === "escalated"
                ? "The runner escalated this to a human — a draft went to review. Check back later."
                : s.state === "failed"
                  ? "The run crashed; the Context's owner sees the failure. You can ask again."
                  : s.state === "closed"
                    ? "This session was closed."
                    : undefined
        return json({
          session_id: s.id,
          context: x.name,
          state: s.state,
          ...(workflowAttempt
            ? {
                workflow: {
                  run_id: workflowAttempt.workflow_run_id,
                  node_id: workflowAttempt.node_id,
                  attempt: workflowAttempt.attempt,
                  status: workflowAttempt.status,
                },
              }
            : {}),
          ...(resultUrl ? { result_url: resultUrl } : {}),
          ...(answerRow
            ? {
                answer: {
                  body_md: clipSessionText(answerRow.body_md, ANSWER_MAX, consoleUrl),
                  meta: parseMeta(answerRow),
                  created_at: answerRow.created_at,
                },
              }
            : {}),
          ...(progressRow
            ? {
                progress: {
                  body_md: clipSessionText(progressRow.body_md, ENTRY_MAX, consoleUrl),
                  created_at: progressRow.created_at,
                },
              }
            : {}),
          ...(checkOnly
            ? {
                transcript: transcript.slice(-20).map((m) => ({
                  author: m.author_kind,
                  body_md: clipSessionText(m.body_md, ENTRY_MAX, consoleUrl),
                  created_at: m.created_at,
                })),
              }
            : {}),
          ...(note ? { note } : {}),
        })
      }

      // CHECK or FOLLOW UP an existing session.
      if (session_id) {
        if (context)
          return err(
            "Pass `context` OR `session_id`, not both — a follow-up already knows its Context.",
          )
        const found = await ctx.meta.getSession(session_id)
        const linked = found?.context_id ? await ctx.meta.getContext(found.context_id) : null
        const workflowAttempt = found
          ? await ctx.meta.getWorkflowStepAttemptBySession(found.id, found.org_id)
          : null
        const workflowRun = workflowAttempt
          ? await ctx.meta.getWorkflowRun(workflowAttempt.workflow_run_id, found?.org_id ?? "")
          : null
        const assignedAgent = registered && workflowRun?.assigned_agent_id === agent.id
        const askerId = assignedAgent ? workflowRun?.initiated_by : actingFor?.id
        // Ownership + the LIVE grant, re-checked per call (a human removed from
        // the workspace/roster loses ask-through-agent the moment they lose
        // ask-directly), and the OAuth grant's workspace clamp. Any miss reads
        // the same as a missing id — a session's existence never leaks.
        const allowed =
          !!found &&
          !!linked &&
          !!askerId &&
          found.asker_id === askerId &&
          inGrant(linked.org_id) &&
          (await ctx.canUserAskContext(askerId, linked))
        if (!found || !linked || !allowed)
          return err(
            `No session "${session_id}" you can reach. find (a Context row) shows your open sessions.`,
          )
        if (!instruction) return reply(found, linked, true)
        if (found.state === "closed")
          return err(
            "That session is closed — open a new one by passing `context` + `instruction`.",
          )
        if (workflowAttempt && isSettled(found.state))
          return err(
            "A settled workflow Context session is immutable; start the next attempt instead.",
          )
        const capped = await overAskCap(askerId)
        if (capped) return capped
        // A follow-up mid-run must NOT vacate an active claim, and reopening must not race a
        // concurrent settle. appendFollowupReopen does both in one atomic compare-and-set: a
        // `working` session stays working (the runner sees the turn on re-read, and its
        // stale-turn guard re-serves it after replying), so a second runner can't claim it;
        // a settled/open one goes to `open`, dropping the dedupe key on the settled path so it
        // can't collide with a newer same-key session. Reading live state inside the UPDATE
        // closes the window a read-then-write would leave (stranding it `working`, no runner).
        await ctx.meta.appendFollowupReopen({
          id: newId("sm"),
          session_id: found.id,
          author_kind: "asker",
          author_id: askerId,
          body_md: instruction,
        })
        // Re-read: the follow-up flipped the session (working stays working; else open).
        return reply((await ctx.meta.getSession(found.id)) ?? found, linked, false)
      }

      // GIVE: open a new session with an instruction.
      if (!context)
        return err(
          "Pass `context` (+ `instruction`) to open a session, or `session_id` to check/resume. find surfaces the Contexts you can use and your open sessions.",
        )
      if (!instruction)
        return err("Opening a session needs an `instruction` — 'with this Context, do this'.")
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const principal = workflow ? await workflowPrincipal(workflow.run_id, t.org) : null
      if (typeof principal === "string") return err(principal)
      const askerId = principal?.askerId ?? actingFor?.id
      if (!askerId) return err(NO_HUMAN)
      if (principal && principal.orgId !== t.org)
        return err("The workflow run and Context must be in the same workspace.")
      const rows = await askableContexts(t.org, askerId)
      const ref = context.trim()
      const hit =
        rows.find((r) => r.x.id === ref) ??
        rows.find((r) => r.x.name.toLowerCase() === ref.toLowerCase())
      // Naming the askable set leaks nothing (each entry is askable by this
      // human, by definition); with nothing askable there is nothing to name.
      if (!hit)
        return err(
          rows.length
            ? `No Context "${context}" you can use here. You can use: ${rows.map((r) => r.x.name).join(", ")}.`
            : "No Contexts you can use in this workspace.",
        )
      if (hit.x.import_source) return err(IMPORTED_NO_RUNS(hit.x.id))
      if (!hit.manifest)
        return err(`Context "${hit.x.name}" has lost its instruction artifact and can't be used.`)
      const manifest = hit.manifest
      if (workflow && principal) {
        const invalidTarget = await prepareWorkflowContextUse({
          meta: ctx.meta,
          ref: workflow,
          orgId: principal.orgId,
          context: hit.x,
          manifest,
        })
        if (typeof invalidTarget === "string") return err(invalidTarget)
      }
      const capped = await overAskCap(askerId)
      if (capped) return capped
      const workflowDedupe = workflow
        ? `${workflow.run_id}:${workflow.node_id}:${workflow.attempt}`
        : undefined
      if (workflowDedupe && dedupe_key && dedupe_key !== workflowDedupe)
        return err(`Workflow attempts use the exact dedupe_key "${workflowDedupe}".`)
      const effectiveDedupe = workflowDedupe ?? dedupe_key
      const bindSession = async (session: SessionRecord): Promise<string | null> => {
        if (!workflow || !principal) return null
        const bound = await bindWorkflowContextSession({
          meta: ctx.meta,
          ref: workflow,
          orgId: principal.orgId,
          context: hit.x,
          manifest,
          session,
          executorId: principal.executorId,
          executionLane: workflowScope ? "github_actions" : "local",
          at: session.created_at,
        })
        return typeof bound === "string" ? bound : null
      }
      // Idempotency: a same-key ask still in flight JOINS the existing session
      // rather than opening a new one — a double "run for brand X" never runs twice.
      if (effectiveDedupe) {
        const inflight = await ctx.meta.findInflightSession(hit.x.id, askerId, effectiveDedupe)
        if (inflight) {
          const bindError = await bindSession(inflight)
          if (bindError) return err(bindError)
          return reply(inflight, hit.x, false)
        }
      }
      // PAYER guard, mirroring the REST ask (routes/contexts.ts): the asker pays, then
      // owner-lend, then the pool. After the dedupe join for the same reason — joining an
      // open session creates no new work.
      //
      // A live external runner is the execution plan. It polls with its own registered-agent
      // bearer or an owner's grant and spends its own model entitlement, so requiring a
      // Derive-hosted model plan here would reject BYO execution that Derive never pays for.
      // Liveness is deliberately narrow (90s): if no runner is actually present, retain the
      // preflight and refuse work that would otherwise be stranded or fall into hosted compute.
      if (
        !runnerOnline(hit.x) &&
        !(await canPayForAgent(ctx.meta, {
          orgId: hit.x.org_id,
          agentId: hit.x.agent_id,
          initiator: { userId: askerId, source: "asker" },
        }))
      )
        return err(NO_PAYER_MESSAGE)
      let opened: SessionRecord
      try {
        opened = await ctx.meta.createSession({
          id: newId("ses"),
          context_id: hit.x.id,
          org_id: hit.x.org_id,
          asker_id: askerId,
          context_version: manifest.current_version,
          dedupe_key: effectiveDedupe,
        })
      } catch (e) {
        // Lost the create race to this asker's own concurrent same-key ask — the partial
        // unique index rejected us; join the winner. Rethrow anything else.
        const winner = effectiveDedupe
          ? await ctx.meta.findInflightSession(hit.x.id, askerId, effectiveDedupe)
          : null
        if (winner) {
          const bindError = await bindSession(winner)
          if (bindError) return err(bindError)
          return reply(winner, hit.x, false)
        }
        throw e
      }
      await ctx.meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: opened.id,
          author_kind: "asker",
          author_id: askerId,
          body_md: instruction,
        },
        "open",
      )
      const bindError = await bindSession(opened)
      if (bindError) {
        await ctx.meta.setSessionState(opened.id, "closed")
        return err(bindError)
      }
      return reply(opened, hit.x, false)
    },
  )
}
