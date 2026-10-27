// Native Luna chat jobs. Workspace chat and artifact Ask share this lifecycle.

import {
  type ArtifactRecord,
  DERIVE_AGENT_ID,
  type JobEffect,
  type JobMessageRecord,
  type JobNeeds,
  type JobRecord,
  jobResult,
  newId,
  type OrgSettings,
  type Role,
} from "@derive/core"
import type { Context } from "hono"
import type { AppContext } from "../context"
import { log } from "../log"
import { chatArrival, refusalMessage } from "./chat-gate"
import { buildChatTools } from "./chat-tools"
import { runChatTurn } from "./chat-turn"
import type { JobDeps } from "./job-policy"
import { isServerNote, wakeSettled } from "./jobs"
import type { ResolvedChatModel } from "./model-catalog"

/** How much of the job's transcript a turn is given. A page conversation is short; past this
 *  the oldest turns fall away rather than growing every call. */
const TRANSCRIPT_CONTEXT = 12

/** Lease past a turn's budget, so a turn that settles itself inside its budget never lapses
 *  and the reaper (every minute) still frees a job whose isolate died soon after. */
const LEASE_SLACK_MS = 2 * 60_000
/** The lease where nothing caps the turn (Node) or where a runner serves it off this clock. */
const DETACHED_LEASE_MS = 10 * 60_000

/** The lease for a turn served on this context's own clock. */
export const ownLeaseMs = (ctx: AppContext) =>
  ctx.attendedTurnBudgetMs ? ctx.attendedTurnBudgetMs + LEASE_SLACK_MS : DETACHED_LEASE_MS

/** The lease the request takes when it starts a turn: its own, unless a runner serves it. */
export const leaseMsFor = (ctx: AppContext) =>
  ctx.chatTurnRunner ? DETACHED_LEASE_MS : ownLeaseMs(ctx)

/** The refusal a turn writes when the turn before it died mid-save. The retry route says the
 *  same thing, because it is the same refusal. */
export const SAVE_INTERRUPTED =
  "A save was interrupted. Check Activity and artifact versions before starting a new chat. This run cannot safely retry."

/** What a turn says when it failed for a reason the person cannot act on. */
export const TURN_FAILED =
  "Something went wrong on my side, so I have not answered that. Try again."

/** The refusal when the page a chat is scoped to cannot be read any more. */
export const PAGE_GONE = "The scoped artifact is no longer accessible."

/** The refusal when the page moved on since the person asked; the same words the ask route
 *  uses for a stale base_version, because it is the same refusal. */
export const PAGE_MOVED = "This artifact changed. Refresh before asking."

/** The tools a page ask holds: Derive's own, and not the workspace's connected sources. A page
 *  ask reads pages that teammates and agents wrote, so the text in front of the model is not the
 *  asker's own words, and a source call is the one tool that reaches outside Derive. */
const PAGE_TOOLS: ReadonlySet<string> = new Set(["find", "read", "catch_up", "publish"])

/** Is this one of the native Luna jobs (as opposed to its Slack threads)? */
export const isPageAsk = (job: JobRecord): boolean => {
  if (job.agent_id !== DERIVE_AGENT_ID) return false
  if (!job.subject_json) return JSON.parse(job.meta_json ?? "{}").via === "chat"
  try {
    return (JSON.parse(job.subject_json) as { kind?: string }).kind === "artifact"
  } catch {
    return false
  }
}

/** A version the turn's publish tool landed, read off the tool's own result (an object, or
 *  its JSON text), so the panel can link it. Anything else is not a publish that landed. */
const publishedBy = (result: unknown, page: ArtifactRecord | null): JobEffect | null => {
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
    label: o.short_id === page?.short_id ? (page?.title ?? "This page") : "Artifact",
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
  input: {
    org: string
    askerId: string
    page: ArtifactRecord | null
    question: string
    selection?: string
    modelId?: string | null
  },
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
    subject_json: input.page ? JSON.stringify({ kind: "artifact", id: input.page.short_id }) : null,
    meta_json: JSON.stringify({
      via: input.page ? "page" : "chat",
      selection: input.selection ?? null,
      model_id: input.modelId ?? null,
    }),
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
  // A lost claim may have committed its save without recording a receipt.
  // Never replay that uncertain operation. The person must inspect Activity first.
  if (JSON.parse(job.meta_json ?? "{}").saving === true) return null
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
          needs_json: job.needs_json,
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
    { status: job.status, updated_at: job.updated_at, needs_json: job.needs_json },
  )

/** How a turn is handed off (dispatchTurn). */
export interface TurnDispatch {
  /** The scoped page's version as the request saw it; null for every turn without a page. */
  baseVersion?: number | null
  /** The turn rebuilt from the job id and the claim alone, for a runner that holds nothing
   *  else. */
  run: (startedAt: string) => Promise<void>
  /** The turn served by this request under `claim` (the job as handed in, or a claim the
   *  request took back from a runner that declined it). */
  serve: (claim: JobRecord) => Promise<void>
  /** Where the request serves it: after its response, or inline when the caller already runs
   *  after one (a webhook's deferred work). */
  later: (work: () => Promise<void>) => Promise<void>
}

/**
 * Hand a running, leased job's turn to the deploy's runner (chatTurnRunner, a Durable Object per
 * conversation on Workers) to serve on its own clock, or serve it through `later` where there is
 * no runner. A runner that cannot take the turn does not lose it: the request takes the claim
 * back and serves it itself. Page asks, Slack mentions and GitHub mentions all go through here.
 */
export const dispatchTurn = async (
  ctx: AppContext,
  job: JobRecord,
  turn: TurnDispatch,
): Promise<void> => {
  const startedAt = job.started_at
  if (!ctx.chatTurnRunner || !startedAt) return turn.later(() => turn.serve(job))
  try {
    await ctx.chatTurnRunner({
      jobId: job.id,
      startedAt,
      baseVersion: turn.baseVersion ?? null,
      run: () => turn.run(startedAt),
    })
  } catch (e) {
    log.warn("chat turn runner declined the turn; serving it after the response", {
      job: job.id,
      error: e instanceof Error ? e.message : String(e),
    })
    // The runner may have taken the turn before its answer failed to arrive, so take a claim
    // of our own: a started_at strictly later than the one it was handed (a reclaim in the
    // same millisecond would repeat it), fenced on the old one, with the request's lease.
    let mine: JobRecord | null
    try {
      mine = await ctx.meta.updateJob(
        job.id,
        {
          started_at: new Date(Math.max(Date.now(), Date.parse(startedAt) + 1)).toISOString(),
          lease_until: new Date(Date.now() + ownLeaseMs(ctx)).toISOString(),
        },
        { status: "running", started_at: startedAt },
      )
    } catch (err) {
      log.error("chat turn could not be taken back from its runner", {
        job: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
      await declineTurn({ meta: ctx.meta, bus: ctx.backplane }, job, TURN_FAILED).catch(() => null)
      return
    }
    if (!mine) {
      log.warn("chat turn moved before the request could take it back", { job: job.id })
      return
    }
    const claim = mine
    await turn.later(() => turn.serve(claim))
  }
}

/** A page ask's turn, through dispatchTurn: after this response, or on the runner. */
export const dispatchPageTurn = (
  ctx: AppContext,
  c: Context,
  job: JobRecord,
  asker: { id: string; name: string | null },
  page: ArtifactRecord | null,
  grant: PageTurnGrant,
): Promise<void> => {
  const baseVersion = page?.current_version ?? null
  return dispatchTurn(ctx, job, {
    baseVersion,
    run: (startedAt) => runPageTurnById(ctx, job.id, startedAt, baseVersion),
    serve: (claim) => servePageTurn(ctx, claim, asker, page, grant),
    later: (work) => ctx.afterResponse(c, work),
  })
}

/**
 * Serve the turn from the job id alone, for a runner that holds nothing else. The request
 * walked every gate before handing the job over; this re-reads what the turn needs (the
 * asker's seat and budget, the page in the job's workspace at the version the request saw,
 * the model) and writes a refusal into the job if any of it moved. The page's own share rules
 * are not re-walked: that needs a request, and tool calls check them per call anyway.
 *
 * Runners are at-least-once, and not every death throws (an evicted object, a CPU ceiling).
 * A stale claim, a settled job, a job left mid-save, and a turn that replied but died before
 * settling are each refused or settled instead of served again.
 */
export const runPageTurnById = async (
  ctx: AppContext,
  jobId: string,
  startedAt?: string,
  baseVersion?: number | null,
): Promise<void> => {
  const { meta } = ctx
  const deps: JobDeps = { meta, bus: ctx.backplane }
  const claimed = await meta.getJob(jobId)
  if (!claimed || !isPageAsk(claimed) || claimed.status !== "running" || !claimed.asked_by) return
  if (startedAt && claimed.started_at !== startedAt) return
  if ((JSON.parse(claimed.meta_json ?? "{}") as { saving?: boolean }).saving === true)
    return declineTurn(deps, claimed, SAVE_INTERRUPTED)
  const askerId = claimed.asked_by
  // The request leased the job for its own clock; this turn knows its budget.
  const job = await meta.updateJob(
    claimed.id,
    { lease_until: new Date(Date.now() + ownLeaseMs(ctx)).toISOString() },
    { status: "running", started_at: claimed.started_at },
  )
  if (!job) return
  // Already answered under this claim: settle as that reply said, do not answer again. The
  // reply's cost is not recorded again. (A turn that published and died before replying is
  // not caught here; the next turn sees the version in its effects.)
  const last = await repliedUnderClaim(meta, job)
  if (last) {
    const said = JSON.parse(last.meta_json ?? "{}") as { outcome?: string; needs?: JobNeeds }
    const status =
      said.outcome === "failed" ? "failed" : said.needs ? ("needs_you" as const) : "succeeded"
    const done = await meta.updateJob(
      job.id,
      {
        status,
        finished_at: status === "needs_you" ? null : new Date().toISOString(),
        needs_json: said.needs ? JSON.stringify(said.needs) : null,
        lease_until: null,
      },
      { status: "running", started_at: job.started_at },
    )
    if (done) wakeSettled(deps, done)
    return
  }
  const about = JSON.parse(job.subject_json ?? "{}") as { id?: string }
  const page = about.id ? await meta.getByShortId(about.id) : null
  if (about.id && (!page || page.org_id !== job.org_id)) return declineTurn(deps, job, PAGE_GONE)
  if (page && baseVersion != null && page.current_version !== baseVersion)
    return declineTurn(deps, job, PAGE_MOVED)
  const modelId = (JSON.parse(job.meta_json ?? "{}") as { model_id?: string | null }).model_id
  const { catalog, slots } = await ctx.modelsFor()
  const gate = await chatArrival(
    { meta, models: catalog ?? undefined, chatAllowlist: ctx.chatAllowlist },
    { org: job.org_id, userId: askerId, modelId: modelId ?? slots.chat ?? null },
  )
  if (!gate.ok) return declineTurn(deps, job, refusalMessage(gate.reason))
  const asker = {
    id: askerId,
    name: (await meta.getUsers([askerId]).catch(() => []))[0]?.name ?? null,
  }
  await servePageTurn(ctx, job, asker, page, gate)
}

/** The reply a turn already wrote under the job's current claim, or null. A runner is
 *  at-least-once: a turn that replied and died before settling is settled from this, never
 *  answered again. */
export const repliedUnderClaim = async (
  meta: JobDeps["meta"],
  job: JobRecord,
): Promise<JobMessageRecord | null> => {
  const last = (await meta.listJobMessages(job.id)).filter((m) => !isServerNote(m)).at(-1)
  return last?.author_kind === "agent" && job.started_at && last.created_at >= job.started_at
    ? last
    : null
}

/** What a mention turn says when it failed for a reason the person cannot act on, including the
 *  refusals that would describe a workspace's setup in a public channel or pull request. */
export const MENTION_FAILED =
  "Something went wrong on my side, so I have not answered that. Try me again."

/** The lane a built-in Derive job's turn belongs to (`meta_json.via`): "slack", "github", or a
 *  page ask's "page" / "chat". Null when the row cannot be read. */
export const turnViaOf = (job: Pick<JobRecord, "meta_json">): string | null => {
  try {
    const via = (JSON.parse(job.meta_json ?? "{}") as { via?: unknown }).via
    return typeof via === "string" ? via : null
  } catch {
    return null
  }
}

/**
 * Record on the job that its turn under this claim has begun (`turn_began`), fenced on the claim,
 * right before the model runs. A mention's tools reach outside Derive (hand_off, a source call)
 * and have no save guard, so a turn that began and died without replying is not run again: the
 * replay finds this and says the turn was interrupted (turnBegan). False when the claim moved.
 */
export const markTurnBegan = async (meta: JobDeps["meta"], job: JobRecord): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await meta.getJob(job.id)
    if (held?.status !== "running" || held.started_at !== job.started_at) return false
    const marked = await meta.updateJob(
      job.id,
      {
        meta_json: JSON.stringify({
          ...JSON.parse(held.meta_json ?? "{}"),
          turn_began: job.started_at,
        }),
      },
      { status: "running", started_at: job.started_at, meta_json: held.meta_json },
    )
    if (marked) return true
  }
  return false
}

/** Whether a turn already began under the job's current claim (markTurnBegan). */
export const turnBegan = (job: JobRecord): boolean => {
  try {
    const began = (JSON.parse(job.meta_json ?? "{}") as { turn_began?: unknown }).turn_began
    return !!job.started_at && began === job.started_at
  } catch {
    return false
  }
}

/** Write `reason` on the job and settle it failed, fenced on its current claim. Throws if the
 *  settle fails, so a runner's retry gets to settle it. */
export const declineTurn = async (deps: JobDeps, job: JobRecord, reason: string): Promise<void> => {
  const { meta } = deps
  await meta
    .addJobMessage({
      id: newId("jm"),
      job_id: job.id,
      author_kind: "agent",
      author_id: DERIVE_AGENT_ID,
      body_md: reason,
      meta_json: JSON.stringify({ outcome: "failed" }),
    })
    .catch(() => null)
  const done = await meta.updateJob(
    job.id,
    {
      status: "failed",
      finished_at: new Date().toISOString(),
      needs_json: null,
      lease_until: null,
    },
    { status: "running", started_at: job.started_at },
  )
  if (done) wakeSettled(deps, done)
}

/**
 * Serve one turn on a running page job, then settle it. Never throws: this runs after the
 * response, where an exception reaches nobody, so a failure is written into the job instead.
 */
export const servePageTurn = async (
  ctx: AppContext,
  job: JobRecord,
  asker: { id: string; name: string | null },
  page: ArtifactRecord | null,
  grant: PageTurnGrant,
): Promise<void> => {
  const { meta } = ctx
  const deps: JobDeps = { meta, bus: ctx.backplane }
  const fence = { status: "running" as const, started_at: job.started_at }
  // What this turn published, kept on the job with what earlier turns published.
  const effects: JobEffect[] = []
  const settle = async (
    status: "succeeded" | "failed" | "needs_you",
    costMicroUsd: number | null,
    needs?: JobNeeds,
  ) => {
    if (costMicroUsd) await meta.addJobCost(job.id, costMicroUsd).catch(() => null)
    const before = jobResult((await meta.getJob(job.id)) ?? job)
    const result = effects.length
      ? {
          result_json: JSON.stringify({
            ...before,
            effects: [
              ...(before.effects ?? []),
              ...effects.filter(
                (e) =>
                  !(before.effects ?? []).some(
                    (saved) => saved.ref === e.ref && saved.version === e.version,
                  ),
              ),
            ],
          }),
        }
      : {}
    const done = await meta
      .updateJob(
        job.id,
        {
          status,
          finished_at: status === "needs_you" ? null : new Date().toISOString(),
          needs_json: needs ? JSON.stringify(needs) : null,
          lease_until: null,
          ...result,
        },
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
        if (!(await stillHeld())) return { error: "This turn no longer holds the job." }
        const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
        if (name === "publish" && page && a.short_id) {
          if (a.short_id !== page.short_id)
            return {
              error:
                "This conversation edits only its scoped artifact. Start a chat on the other artifact.",
            }
          const head = await meta.getByShortId(page.short_id)
          if (!head || head.current_version !== page.current_version)
            return {
              error:
                "The artifact changed during this turn. Stop and ask the person to start a new turn.",
            }
          const selection = (JSON.parse(job.meta_json ?? "{}") as { selection?: string }).selection
          if (selection) {
            const edits = a.edits as
              | {
                  old_str?: string
                  occurrence?: number
                  quote?: { exact?: string; prefix?: string; suffix?: string; occurrence?: number }
                }[]
              | undefined
            if (
              !edits?.length ||
              edits.some(
                (e) =>
                  !(e.quote?.exact ?? e.old_str)?.length ||
                  !selection.includes(e.quote?.exact ?? e.old_str ?? "\0") ||
                  e.occurrence !== undefined ||
                  e.quote?.occurrence !== undefined ||
                  e.quote?.prefix !== undefined ||
                  e.quote?.suffix !== undefined,
              )
            )
              return {
                error:
                  "Only focused edits inside the selected text are allowed. Use visible quote edits.",
              }
          }
        }
        if (name === "publish") {
          const held = await meta.getJob(job.id)
          if (!held || held.status !== "running" || held.started_at !== job.started_at)
            return { error: "This turn stopped before saving." }
          const locked = await meta.updateJob(
            job.id,
            { meta_json: JSON.stringify({ ...JSON.parse(held.meta_json ?? "{}"), saving: true }) },
            { status: "running", started_at: job.started_at, updated_at: held.updated_at },
          )
          if (!locked) return { error: "This turn stopped before saving." }
        }
        let out: unknown
        try {
          out = await tools.execute(name, args)
          const landed = name === "publish" ? publishedBy(out, page) : null
          if (landed) {
            effects.push(landed)
            const held = await meta.getJob(job.id)
            if (held)
              await meta.updateJob(
                job.id,
                {
                  result_json: JSON.stringify({
                    ...jobResult(held),
                    effects: [...(jobResult(held).effects ?? []), landed],
                  }),
                },
                fence,
              )
          }
        } finally {
          if (name === "publish") {
            const held = await meta.getJob(job.id)
            if (held)
              await meta.updateJob(
                job.id,
                {
                  meta_json: JSON.stringify({
                    ...JSON.parse(held.meta_json ?? "{}"),
                    saving: false,
                  }),
                },
                { status: "running", started_at: job.started_at },
              )
          }
        }
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
        canAskUser: true,
        completedEffects: jobResult(job).effects,
        stillHeld,
        ...(page
          ? {
              page: {
                shortId: page.short_id,
                title: page.title ?? null,
                version: page.current_version,
                selection: (JSON.parse(job.meta_json ?? "{}") as { selection?: string }).selection,
              },
            }
          : {}),
      },
    )
    // A turn that outlived its claim (reaped as lost, or another turn started since) does not
    // speak: its answer would land after the job already said it stopped.
    if (!(await stillHeld())) {
      if (res.costMicroUsd) await meta.addJobCost(job.id, res.costMicroUsd).catch(() => null)
      const stopped = await meta.getJob(job.id)
      if (stopped?.status === "cancelled" && effects.length)
        await meta.updateJob(
          job.id,
          {
            result_json: JSON.stringify({
              ...jobResult(stopped),
              effects: [
                ...(jobResult(stopped).effects ?? []),
                ...effects.filter(
                  (e) =>
                    !(jobResult(stopped).effects ?? []).some(
                      (saved) => saved.ref === e.ref && saved.version === e.version,
                    ),
                ),
              ],
            }),
          },
          { status: "cancelled" },
        )
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
        // Kept with the reply so a runner that finds the reply written but the job unsettled
        // (runPageTurnById) can settle it the way this turn would have.
        needs: res.needs ?? null,
        model: res.model,
        model_ms: res.modelMs,
        tools: res.tools,
        tool_errors: res.toolErrors,
        via: page ? "page" : "chat",
      }),
    })
    await settle(
      res.outcome === "failed" ? "failed" : res.needs ? "needs_you" : "succeeded",
      res.costMicroUsd,
      res.needs,
    )
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
        body_md: TURN_FAILED,
      })
      .catch(() => null)
    await settle("failed", null)
  }
}
