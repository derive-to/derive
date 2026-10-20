import type { DurableObjectState, ExecutionContext } from "@cloudflare/workers-types"
import { type AppContext, buildContext } from "./context"
import { CHAT_TURN_PATH, type Env, edgeAppDeps } from "./edge-deps"
import { hyperdriveConn, requestPg, tickStore } from "./edge-pg"
import { declineTurn, runPageTurnById, TURN_FAILED } from "./lib/page-ask"
import { requestD1 } from "./lib/request-d1"
import { log } from "./log"
import { createDoBackplane, edgeCtx } from "./realtime-do"

/** How long a turn may run here before it settles its job as too long. The turn leases the
 *  job for this plus slack when it starts (runPageTurnById), so a live turn is never reaped. */
export const CHAT_TURN_BUDGET_MS = 8 * 60_000

/** Alarms that threw (store or context failing to come up; the turn itself never throws) are
 *  retried this many times before the job is settled failed. */
const MAX_ATTEMPTS = 3

// Storage key for the turn this object serves. Never deleted: a poke for the next turn can
// land while the previous alarm is winding down, and the claim, not the key, decides what runs.
const TURN_KEY = "turn"

interface Turn {
  job_id: string
  /** The job's started_at when the turn was handed over. A later claim supersedes it. */
  started_at: string
  attempts: number
}

/**
 * One built-in Derive chat turn, served on a Durable Object per conversation (named by job id).
 *
 * A request's after-response work on Workers ends a short while after the response, and dies
 * with the request isolate. A turn served here runs on the object's own clock, in the object's
 * own isolate, under CHAT_TURN_BUDGET_MS.
 *
 * The request opens and leases the job, then pokes this object with the id and the claim
 * (pokeChatTurn). `fetch` records both and arms an alarm; `alarm` rebuilds the turn from the job
 * row (runPageTurnById) and serves it. The job row stays the source of truth: the object holds
 * nothing else, and a job whose claim lapsed or changed hands is left alone.
 *
 * Turns on one job are serialized by the job's status fence (continuePageAsk), so an alarm
 * never races another turn on the same object.
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
    } | null
    const jobId = typeof body?.job_id === "string" ? body.job_id : ""
    const startedAt = typeof body?.started_at === "string" ? body.started_at : ""
    if (!jobId.startsWith("job_") || !startedAt) return new Response("not a turn", { status: 400 })
    const turn: Turn = { job_id: jobId, started_at: startedAt, attempts: 0 }
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
    const serve = () =>
      withEdgeWork(() => runPageTurnById(this.context(), turn.job_id, turn.started_at))
    try {
      await (conn ? requestPg.run(conn, serve) : requestD1.run(this.env.DB, serve))
    } catch (error) {
      const attempts = turn.attempts + 1
      log.error("chat turn alarm failed", {
        job: turn.job_id,
        attempt: attempts,
        error: error instanceof Error ? error.message : String(error),
      })
      if (attempts < MAX_ATTEMPTS) {
        await this.state.storage.put(TURN_KEY, { ...turn, attempts })
        // The runtime retries an alarm that throws.
        throw error
      }
      await this.settleFailed(turn)
    } finally {
      await conn?.end().catch(() => {})
    }
  }

  /** Out of retries: tell the job, with a store of this alarm's own since the context may be
   *  what failed, and only if the job still runs under the claim this object was handed. */
  private async settleFailed(turn: Turn): Promise<void> {
    const { store, close } = tickStore(this.env)
    try {
      const job = await store.getJob(turn.job_id)
      if (job?.status === "running" && job.started_at === turn.started_at)
        await withEdgeWork(() =>
          declineTurn({ meta: store, bus: createDoBackplane(this.env.ROOMS) }, job, TURN_FAILED),
        )
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
