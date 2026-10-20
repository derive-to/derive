import type { DurableObjectState, ExecutionContext } from "@cloudflare/workers-types"
import { type AppContext, buildContext } from "./context"
import { CHAT_TURN_PATH, type Env, edgeAppDeps } from "./edge-deps"
import { hyperdriveConn, requestPg, tickStore } from "./edge-pg"
import { declineTurn, runPageTurnById } from "./lib/page-ask"
import { requestD1 } from "./lib/request-d1"
import { log } from "./log"
import { createDoBackplane, edgeCtx } from "./realtime-do"

/**
 * How long a turn may run here before it gives up and settles the job itself. Far past the 22
 * seconds the request isolate could give it; the turn leases the job for this plus slack when
 * it starts (page-ask.ts runPageTurnById), so the reaper never calls a live turn lost.
 */
export const CHAT_TURN_BUDGET_MS = 8 * 60_000

/** How many times an alarm that threw (the store or the context failing to come up, never the
 *  turn itself) is run again before the job is told the turn failed. */
const MAX_ATTEMPTS = 3

// The turn this instance serves, kept in storage so the alarm has it: an alarm has no request
// to read it from, and a retried alarm (the runtime re-runs one that threw) needs it still.
// Never deleted: a poke for the next turn can land while the previous alarm is winding down,
// and deleting after that would drop it. The claim decides what runs, not the key.
const TURN_KEY = "turn"

interface Turn {
  job_id: string
  /** The claim this turn runs under (the job's started_at); a later claim supersedes it. */
  started_at: string
  attempts: number
}

const FAILED = "Something went wrong on my side, so I have not answered that. Try again."

/**
 * A built-in Derive chat turn, served on a Durable Object of its own — one instance per
 * conversation, named by the job id.
 *
 * WHY NOT THE REQUEST. On Workers the turn used to run after the response through waitUntil,
 * which the runtime ends a short while after the response is sent: the turn got 22 seconds for
 * every model call and tool call together, and it died, silently and unsettled, whenever the
 * request isolate was reclaimed — including when some other request on that isolate pushed it
 * over its memory limit. Here the turn runs on the object's own clock, in the object's own
 * isolate, with the budget above.
 *
 * HOW. The request opens the job and leases it (openPageAsk / continuePageAsk), then pokes
 * this object with the id and the claim (pokeChatTurn). `fetch` only records them and arms an
 * alarm, so the poke returns at once; `alarm` rebuilds the turn from the job row
 * (runPageTurnById) and serves it. The DB row is the source of truth throughout: the object
 * holds the id and the claim and nothing else, so losing it only delays the turn to the
 * alarm's retry, and a job whose claim lapsed or changed hands is left alone.
 *
 * One conversation, one object, one turn at a time: a second turn on the same job cannot start
 * while one runs (continuePageAsk fences on the job's status), so the alarm never races itself.
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
    // Now, not after a delay: a person is watching this conversation.
    await this.state.storage.setAlarm(Date.now())
    return new Response("accepted", { status: 202 })
  }

  async alarm(): Promise<void> {
    const turn = await this.state.storage.get<Turn>(TURN_KEY)
    if (!turn) return
    // Store bindings are request-scoped (edge-pg.ts, request-d1.ts): bind this alarm's own
    // connection the way the request handler and the cron do, and release it when done —
    // unlike a request, nothing here outlives the handler.
    const conn = this.env.HYPERDRIVE ? hyperdriveConn(this.env.HYPERDRIVE) : null
    try {
      await (conn
        ? requestPg.run(conn, () =>
            withEdgeWork(() => runPageTurnById(this.context(), turn.job_id, turn.started_at)),
          )
        : requestD1.run(this.env.DB, () =>
            withEdgeWork(() => runPageTurnById(this.context(), turn.job_id, turn.started_at)),
          ))
    } catch (error) {
      // The turn itself never throws (servePageTurn writes its own failures), so this is the
      // store or the context failing to come up. Rethrown, the runtime runs the alarm again;
      // out of attempts, the job is told rather than left running until its lease lapses.
      const attempts = turn.attempts + 1
      log.error("chat turn alarm failed", {
        job: turn.job_id,
        attempt: attempts,
        error: error instanceof Error ? error.message : String(error),
      })
      if (attempts < MAX_ATTEMPTS) {
        await this.state.storage.put(TURN_KEY, { ...turn, attempts })
        throw error
      }
      await this.giveUp(turn)
    } finally {
      await conn?.end().catch(() => {})
    }
  }

  /** Settle the job failed with a store of this alarm's own, since the context may be what
   *  failed to build — and only if it still runs under the claim this object was handed. */
  private async giveUp(turn: Turn): Promise<void> {
    const { store, close } = tickStore(this.env)
    try {
      const job = await store.getJob(turn.job_id)
      if (job?.status === "running" && job.started_at === turn.started_at)
        await withEdgeWork(() =>
          declineTurn({ meta: store, bus: createDoBackplane(this.env.ROOMS) }, job, FAILED),
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

  /** The application context, built once per object from the same deps as the Worker's app,
   *  with this object's own ceiling and no runner of its own (the turn is already here). */
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
 * Run `work` with the context's after-the-fact work (realtime fan-out, notifications, outbox
 * pokes) collected and waited for. That work rides waitUntil on the request isolate; there is
 * no request here, and an alarm that returns ends the object's work, so it is drained first —
 * repeatedly, since work started late (a notification's own outbox poke) lands after the
 * first pass.
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
