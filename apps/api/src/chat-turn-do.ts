import type { DurableObjectState, ExecutionContext } from "@cloudflare/workers-types"
import { type AppContext, buildContext } from "./context"
import { CHAT_TURN_PATH, type Env, edgeAppDeps } from "./edge-deps"
import { hyperdriveConn, requestPg, tickStore } from "./edge-pg"
import { runGithubMentionTurnById, tellGithubMentionFailed } from "./lib/github-mention"
import { declineTurn, runPageTurnById, TURN_FAILED, turnViaOf } from "./lib/page-ask"
import { requestD1 } from "./lib/request-d1"
import { runSlackMentionTurnById, tellSlackMentionFailed } from "./lib/slack-mention"
import { log } from "./log"
import { createDoBackplane, edgeCtx } from "./realtime-do"

/** How long a turn may run here before it settles its job as too long. The turn leases the
 *  job for this plus slack when it starts (runPageTurnById), so a live turn is never reaped. */
const CHAT_TURN_BUDGET_MS = 8 * 60_000

/** How many times an alarm that threw is run again before the job is settled failed. The
 *  turn's own failures are written into the job and never throw; a throw here is the store or
 *  the context failing to come up, or a store call inside the turn failing. */
const MAX_ATTEMPTS = 3

// Storage key for the turn this object serves.
const TURN_KEY = "turn"

interface Turn {
  job_id: string
  /** The job's started_at when the turn was handed over. A later claim supersedes it. */
  started_at: string
  /** The scoped page's version as the request saw it; null for a workspace chat. */
  base_version: number | null
  attempts: number
}

/**
 * One built-in Derive chat turn (a page ask, or an @Derive mention in Slack or on a pull
 * request), served on a Durable Object per conversation (named by job id).
 *
 * A request's after-response work on Workers ends a short while after the response, and dies
 * with the request isolate. A turn served here runs on the object's own clock, in the object's
 * own isolate, under CHAT_TURN_BUDGET_MS.
 *
 * The request opens and leases the job, then pokes this object with the id and the claim
 * (pokeChatTurn). `fetch` records both and arms an alarm; `alarm` rebuilds the turn from the job
 * row (runTurnById: a page ask, an @Derive mention in Slack, or an @derive mention on a pull
 * request) and serves it. The job row stays the source of truth: the object holds
 * nothing else, and a job whose claim lapsed or changed hands is left alone.
 *
 * Turns on one job are serialized by the job's status fence (continuePageAsk), so an alarm
 * never races another turn on the same object. A poke CAN land while an alarm is winding down,
 * so the stored turn is only ever replaced or deleted after comparing its claim.
 */
export class ChatTurn {
  private app: AppContext | null = null

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== CHAT_TURN_PATH)
      return new Response("not found", { status: 404 })
    const body = (await req.json().catch(() => null)) as {
      job_id?: unknown
      started_at?: unknown
      base_version?: unknown
    } | null
    const jobId = typeof body?.job_id === "string" ? body.job_id : ""
    const startedAt = typeof body?.started_at === "string" ? body.started_at : ""
    if (!jobId.startsWith("job_") || !startedAt) return new Response("not a turn", { status: 400 })
    const turn: Turn = {
      job_id: jobId,
      started_at: startedAt,
      base_version: typeof body?.base_version === "number" ? body.base_version : null,
      attempts: 0,
    }
    await this.state.storage.put(TURN_KEY, turn)
    await this.state.storage.setAlarm(Date.now())
    return new Response("accepted", { status: 202 })
  }

  async alarm(): Promise<void> {
    const turn = await this.state.storage.get<Turn>(TURN_KEY)
    if (!turn) return
    // Store bindings are request-scoped (edge-pg.ts, request-d1.ts). Nothing here outlives the
    // handler, so the connection is released when it returns.
    const conn = this.env.HYPERDRIVE ? hyperdriveConn(this.env.HYPERDRIVE) : null
    const serve = () => withEdgeWork(() => runTurnById(this.context(), turn))
    try {
      await (conn ? requestPg.run(conn, serve) : requestD1.run(this.env.DB, serve))
      await this.forget(turn)
    } catch (error) {
      const attempts = turn.attempts + 1
      log.error("chat turn alarm failed", {
        job: turn.job_id,
        attempt: attempts,
        error: error instanceof Error ? error.message : String(error),
      })
      if (attempts < MAX_ATTEMPTS) {
        if (await this.stillStored(turn))
          await this.state.storage.put(TURN_KEY, { ...turn, attempts })
        // The runtime retries an alarm that throws.
        throw error
      }
      await this.settleFailed(turn)
      await this.forget(turn)
    } finally {
      await conn?.end().catch(() => {})
    }
  }

  /** Whether the stored turn is still this one. Storage calls keep the input gate closed, so a
   *  check-then-write that awaits only storage sees no poke in between. */
  private async stillStored(turn: Turn): Promise<boolean> {
    return (await this.state.storage.get<Turn>(TURN_KEY))?.started_at === turn.started_at
  }

  /** Drop the stored turn once served, unless a later poke replaced it meanwhile. */
  private async forget(turn: Turn): Promise<void> {
    if (await this.stillStored(turn)) await this.state.storage.delete(TURN_KEY)
  }

  /** Out of retries: tell the job, with a store of this alarm's own since the context may be
   *  what failed, and only if the job still runs under the claim this object was handed. */
  private async settleFailed(turn: Turn): Promise<void> {
    const { store, close } = tickStore(this.env)
    try {
      const job = await store.getJob(turn.job_id)
      if (job?.status === "running" && job.started_at === turn.started_at) {
        // A mention's person is waiting in Slack or on a pull request, not on the job page: the
        // placeholder is told first, best effort, then the job settles.
        const via = turnViaOf(job)
        const key = this.env.DERIVE_AUTH_SECRET
        if (via === "slack") await tellSlackMentionFailed(store, key, job)
        else if (via === "github")
          await tellGithubMentionFailed(store, key, this.env.BASE_URL ?? "", job)
        await withEdgeWork(() =>
          declineTurn({ meta: store, bus: createDoBackplane(this.env.ROOMS) }, job, TURN_FAILED),
        )
      }
    } catch (error) {
      log.error("chat turn could not be settled after its alarm failed", {
        job: turn.job_id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await close().catch(() => {})
    }
  }

  /** The app context, built once per object from the Worker's own deps. */
  private context(): AppContext {
    if (this.app) return this.app
    const baseUrl = this.env.BASE_URL
    if (!baseUrl) throw new Error("BASE_URL is required to serve chat turns")
    this.app = buildContext({
      ...edgeAppDeps(this.env, baseUrl),
      attendedTurnBudgetMs: CHAT_TURN_BUDGET_MS,
      chatTurnRunner: undefined,
    })
    return this.app
  }
}

/**
 * Serve a turn by its job, deciding what kind of turn it is from the job row rather than the
 * poke, so a replayed alarm serves what the job is now. Each lane re-checks the claim, the
 * job's status and its own gates, and stays silent on a job that is not its own.
 */
const runTurnById = async (ctx: AppContext, turn: Turn): Promise<void> => {
  const job = await ctx.meta.getJob(turn.job_id)
  if (!job) return
  const via = turnViaOf(job)
  if (via === "slack") await runSlackMentionTurnById(ctx, job.id, turn.started_at)
  else if (via === "github") await runGithubMentionTurnById(ctx, job.id, turn.started_at)
  else await runPageTurnById(ctx, job.id, turn.started_at, turn.base_version)
}

/**
 * Run `work` and wait for everything it handed to waitUntil (realtime fan-out, notifications,
 * outbox pokes). There is no request context here and an alarm that returns ends the object's
 * work, so the queue is drained until empty: work started late (a notification's own outbox
 * poke) lands after the first pass.
 */
const withEdgeWork = async (work: () => Promise<void>): Promise<void> => {
  const pending: Promise<unknown>[] = []
  const ec = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p)
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext
  try {
    await edgeCtx.run(ec, work)
  } finally {
    while (pending.length) await Promise.allSettled(pending.splice(0))
  }
}
