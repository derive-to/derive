// THE BUILT-IN DERIVE, ASKED FROM A PAGE (the margin Ask).
//
// Its sibling is slack-mention.ts: same job shape (one attended job on DERIVE_AGENT_ID, private
// to its asker), same turn (chat-turn.ts with Derive's own MCP tools acting as the asker at their
// seat), same lease. What differs is where the question comes from and where the answer goes: a
// person on a page asks about THAT page, and the reply is a job message the margin follows, so
// there is nothing to deliver beyond the job itself.
//
// Unlike an agent on someone's machine, nothing has to pick this job up: the request that opened
// it serves it, after the response (ctx.afterResponse), so the asker sees an answer in seconds.

import {
  type ArtifactRecord,
  DERIVE_AGENT_ID,
  type JobRecord,
  newId,
  type OrgSettings,
  type Role,
} from "@derive/core"
import type { AppContext } from "../context"
import { log } from "../log"
import { buildChatTools } from "./chat-tools"
import { runChatTurn } from "./chat-turn"
import { isServerNote, type JobDeps, wakeSettled } from "./jobs"
import type { ResolvedChatModel } from "./model-catalog"

/** How much of the job's transcript a turn is given. A margin conversation is short; past this
 *  the oldest turns fall away rather than growing every call. */
const TRANSCRIPT_CONTEXT = 12

/** How long a turn holds its job before the reaper may call it lost. Far past any turn ceiling,
 *  so only a request that died mid-turn ever reaches it. */
export const PAGE_TURN_LEASE_MS = 10 * 60 * 1000

/** Is this one of the built-in Derive's page jobs (as opposed to its Slack threads)? */
export const isPageAsk = (job: JobRecord): boolean => {
  if (job.agent_id !== DERIVE_AGENT_ID || !job.subject_json) return false
  try {
    return (JSON.parse(job.subject_json) as { kind?: string }).kind === "artifact"
  } catch {
    return false
  }
}

/** What a passed chat gate hands the turn. */
export interface PageTurnGrant {
  settings: OrgSettings
  seatRole: Role
  model: ResolvedChatModel
}

/** Open a page ask: the job, the question as its first message, and the job running under a
 *  lease, all before the response, so the asker can follow it at once. */
export const openPageAsk = async (
  ctx: AppContext,
  input: { org: string; askerId: string; page: ArtifactRecord; question: string },
): Promise<JobRecord> => {
  const { meta } = ctx
  const job = await meta.createJob({
    id: newId("job"),
    org_id: input.org,
    agent_id: DERIVE_AGENT_ID,
    kind: "ask",
    instruction: input.question,
    asked_by: input.askerId,
    // The asker's: a personal budget counts only their jobs, the pool's counts every job.
    payer_id: input.askerId,
    attended: 1,
    subject_json: JSON.stringify({ kind: "artifact", id: input.page.short_id }),
    meta_json: JSON.stringify({ via: "page" }),
  })
  await meta.addJobMessage({
    id: newId("jm"),
    job_id: job.id,
    author_kind: "asker",
    author_id: input.askerId,
    body_md: input.question,
  })
  return (await startTurn(ctx, job)) ?? job
}

/** A follow-up on a settled page ask: the message, and the same job running again. Null when
 *  the job moved under us (a second follow-up racing this one). */
export const continuePageAsk = async (
  ctx: AppContext,
  job: JobRecord,
  askerId: string,
  body: string,
): Promise<JobRecord | null> => {
  const running = await startTurn(ctx, job)
  if (!running) return null
  await ctx.meta.addJobMessage({
    id: newId("jm"),
    job_id: job.id,
    author_kind: "asker",
    author_id: askerId,
    body_md: body,
  })
  return running
}

/** Mark the job running under a fresh lease, fenced on the status it had: two requests racing to
 *  start a turn on one job get one turn. */
const startTurn = (ctx: AppContext, job: JobRecord) =>
  ctx.meta.updateJob(
    job.id,
    {
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      needs_json: null,
      lease_until: new Date(Date.now() + PAGE_TURN_LEASE_MS).toISOString(),
    },
    { status: job.status },
  )

/**
 * Serve one turn on a running page job, then settle it. Never throws: this runs after the
 * response, where an exception reaches nobody, so a failure is written into the job instead.
 */
export const servePageTurn = async (
  ctx: AppContext,
  job: JobRecord,
  asker: { id: string; name: string | null },
  page: ArtifactRecord,
  grant: PageTurnGrant,
): Promise<void> => {
  const { meta } = ctx
  const deps: JobDeps = { meta, bus: ctx.backplane }
  const fence = { status: "running" as const, started_at: job.started_at }
  const settle = async (status: "succeeded" | "failed", costMicroUsd: number | null) => {
    if (costMicroUsd) await meta.addJobCost(job.id, costMicroUsd).catch(() => null)
    const done = await meta
      .updateJob(
        job.id,
        { status, finished_at: new Date().toISOString(), lease_until: null },
        fence,
      )
      .catch((e) => {
        log.warn("page ask settle failed", { job: job.id, error: String(e) })
        return null
      })
    if (done) wakeSettled(deps, done)
  }
  try {
    const tools = buildChatTools(ctx, {
      org: job.org_id,
      user: asker,
      seatRole: grant.seatRole,
      flags: { agentWrites: grant.settings.agentWrites },
    })
    const res = await runChatTurn(
      { model: grant.model },
      {
        jobId: job.id,
        transcript: (await meta.listJobMessages(job.id))
          .filter((m) => !isServerNote(m))
          .slice(-TRANSCRIPT_CONTEXT),
        tools,
        workspaceName:
          (await meta.getWorkspace(job.org_id).catch(() => null))?.name ?? "this workspace",
        asker: { name: asker.name, role: grant.seatRole },
        skills: tools.skills,
        page: { shortId: page.short_id, title: page.title ?? null },
      },
    )
    await meta.addJobMessage({
      id: newId("jm"),
      job_id: job.id,
      author_kind: "agent",
      author_id: DERIVE_AGENT_ID,
      body_md: res.reply,
      meta_json: JSON.stringify({
        outcome: res.outcome,
        model: res.model,
        model_ms: res.modelMs,
        tools: res.tools,
        via: "page",
      }),
    })
    await settle(res.outcome === "failed" ? "failed" : "succeeded", res.costMicroUsd)
  } catch (e) {
    log.error("page ask turn failed", {
      job: job.id,
      error: e instanceof Error ? e.message : String(e),
    })
    await meta
      .addJobMessage({
        id: newId("jm"),
        job_id: job.id,
        author_kind: "agent",
        author_id: DERIVE_AGENT_ID,
        body_md: "Something went wrong on my side, so I have not answered that. Try again.",
      })
      .catch(() => null)
    await settle("failed", null)
  }
}
