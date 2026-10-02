// THE BUILT-IN DERIVE, ASKED FROM A PAGE (the Ask panel).
//
// Its sibling is slack-mention.ts: same job shape (one attended job on DERIVE_AGENT_ID, private
// to its asker), same turn (chat-turn.ts with Derive's own MCP tools acting as the asker at their
// seat), same lease. What differs is where the question comes from and where the answer goes: a
// person on a page asks about THAT page, and the reply is a job message the Ask panel follows, so
// there is nothing to deliver beyond the job itself.
//
// Unlike an agent on someone's machine, nothing has to pick this job up: the request that opened
// it serves it, after the response (ctx.afterResponse), so the asker sees an answer in seconds.

import {
  type ArtifactRecord,
  DERIVE_AGENT_ID,
  type JobEffect,
  type JobRecord,
  jobResult,
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

/** How much of the job's transcript a turn is given. A page conversation is short; past this
 *  the oldest turns fall away rather than growing every call. */
const TRANSCRIPT_CONTEXT = 12

/**
 * How long a turn holds its job before the reaper may call it lost.
 *
 * Where the runtime puts a ceiling on the turn (attendedTurnBudgetMs, Workers), the turn settles
 * itself inside that ceiling, so a lease a little past it only ever lapses for an isolate that
 * died, and the reaper (every minute) frees the job soon after. Without a ceiling (Node) a turn
 * may legitimately run for minutes, so the lease stays long enough not to reap a live one.
 */
const leaseMsFor = (ctx: AppContext) => (ctx.attendedTurnBudgetMs ? 2 * 60_000 : 10 * 60_000)

/** The tools a page ask holds: Derive's own, and not the workspace's connected sources. A page
 *  ask reads pages that teammates and agents wrote, so the text in front of the model is not the
 *  asker's own words, and a source call is the one tool that reaches outside Derive. */
const PAGE_TOOLS: ReadonlySet<string> = new Set(["find", "read", "publish"])

/** Is this one of the built-in Derive's page jobs (as opposed to its Slack threads)? */
export const isPageAsk = (job: JobRecord): boolean => {
  if (job.agent_id !== DERIVE_AGENT_ID || !job.subject_json) return false
  try {
    return (JSON.parse(job.subject_json) as { kind?: string }).kind === "artifact"
  } catch {
    return false
  }
}

/** A version the turn's publish tool landed, read off the tool's own result (an object, or
 *  its JSON text), so the panel can link it. Anything else is not a publish that landed. */
const publishedBy = (result: unknown, page: ArtifactRecord): JobEffect | null => {
  let r = result
  if (typeof r === "string") {
    try {
      r = JSON.parse(r)
    } catch {
      return null
    }
  }
  const o = r as { published?: unknown; short_id?: unknown; version?: unknown } | null
  if (o?.published !== true || typeof o.short_id !== "string") return null
  if (typeof o.version !== "number") return null
  return {
    kind: "page",
    label: o.short_id === page.short_id ? (page.title ?? "This page") : "A new page",
    ref: o.short_id,
    version: o.version,
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
  try {
    await ctx.meta.addJobMessage({
      id: newId("jm"),
      job_id: job.id,
      author_kind: "asker",
      author_id: askerId,
      body_md: body,
    })
  } catch (e) {
    // No message, no turn: put the job back where it was rather than leave it running with
    // nothing to answer until its lease lapses.
    await ctx.meta
      .updateJob(
        job.id,
        {
          status: job.status,
          started_at: job.started_at,
          finished_at: job.finished_at,
          lease_until: null,
        },
        { status: "running", started_at: running.started_at },
      )
      .catch(() => null)
    throw e
  }
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
      lease_until: new Date(Date.now() + leaseMsFor(ctx)).toISOString(),
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
  // What this turn published, kept on the job with what earlier turns published.
  const effects: JobEffect[] = []
  const settle = async (status: "succeeded" | "failed", costMicroUsd: number | null) => {
    if (costMicroUsd) await meta.addJobCost(job.id, costMicroUsd).catch(() => null)
    const before = jobResult(job)
    const result = effects.length
      ? {
          result_json: JSON.stringify({
            ...before,
            effects: [...(before.effects ?? []), ...effects],
          }),
        }
      : {}
    const done = await meta
      .updateJob(
        job.id,
        { status, finished_at: new Date().toISOString(), lease_until: null, ...result },
        fence,
      )
      .catch((e) => {
        log.warn("page ask settle failed", { job: job.id, error: String(e) })
        return null
      })
    if (done) wakeSettled(deps, done)
  }
  const stillHeld = async () => {
    const now = await meta.getJob(job.id).catch(() => null)
    return now?.status === "running" && now.started_at === job.started_at
  }
  try {
    const tools = buildChatTools(
      ctx,
      {
        org: job.org_id,
        user: asker,
        seatRole: grant.seatRole,
        flags: { agentWrites: grant.settings.agentWrites },
      },
      PAGE_TOOLS,
    )
    // The same tools, noting each version a publish lands so the job can link it.
    const watched = {
      ...tools,
      execute: async (name: string, args: unknown) => {
        const out = await tools.execute(name, args)
        const landed = name === "publish" ? publishedBy(out, page) : null
        if (landed) effects.push(landed)
        return out
      },
    }
    const res = await runChatTurn(
      { model: grant.model, budgetMs: ctx.attendedTurnBudgetMs },
      {
        jobId: job.id,
        transcript: (await meta.listJobMessages(job.id))
          .filter((m) => !isServerNote(m))
          .slice(-TRANSCRIPT_CONTEXT),
        tools: watched,
        workspaceName:
          (await meta.getWorkspace(job.org_id).catch(() => null))?.name ?? "this workspace",
        asker: { name: asker.name, role: grant.seatRole },
        skills: tools.skills,
        page: { shortId: page.short_id, title: page.title ?? null },
      },
    )
    // A turn that outlived its claim (reaped as lost, or another turn started since) does not
    // speak: its answer would land after the job already said it stopped.
    if (!(await stillHeld())) {
      if (res.costMicroUsd) await meta.addJobCost(job.id, res.costMicroUsd).catch(() => null)
      log.warn("page ask answered after its claim ended", { job: job.id })
      return
    }
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
    if (!(await stillHeld())) return
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
