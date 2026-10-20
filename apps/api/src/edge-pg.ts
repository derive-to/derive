import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database, Hyperdrive } from "@cloudflare/workers-types"
import type { MetaStore } from "@derive/core"
import { createD1Store } from "@derive/db/d1"
import { PgMetaStore } from "@derive/db/pg"
import { Client, type Pool, type PoolClient } from "pg"

/**
 * Postgres plumbing for the Workers tier (the HYPERDRIVE binding).
 *
 * HYPERDRIVE ALREADY POOLS — a `pg.Pool` on top of it is broken. The Workers
 * runtime can't keep a Pool's sockets alive across the request↔waitUntil boundary,
 * and Hyperdrive terminates the extra/idle server connections a Pool opens; the
 * next query then fails with **"Connection terminated unexpectedly"** (which took
 * down sign-in / get-session / presence in prod). So the edge tier opens exactly
 * ONE `pg.Client` per invocation and lets Hyperdrive multiplex server-side.
 *
 * NEVER use `pg.Pool` on this path — the `check-hyperdrive-no-pool` lint fails the
 * build if `new Pool(` reappears in this file or worker.ts.
 *
 * drizzle and Better Auth's Kysely core both expect a Pool, so `pgFacade` wraps the
 * single client in a Pool-shaped object (`.query` / `.connect` / `.end`) — one
 * connection underneath, concurrent queries serialized by node-postgres's own queue.
 */

/** The slice of `pg.Pool` drizzle + Kysely actually call. */
export type PgConn = Pick<Pool, "query" | "connect" | "end">

/** Pool-shaped facade over a SINGLE client — Hyperdrive multiplexes, so one socket
 *  is all we open, and `connect()` hands back that same socket (release is a no-op:
 *  there is no pool to return it to).
 *
 *  A socket that dropped while idle is re-dialled on the next query: a chat turn on its
 *  Durable Object (chat-turn-do.ts) holds the socket across a model call that can take
 *  minutes. Only a drop seen before the query is issued re-dials, and never inside a
 *  transaction: drizzle and Kysely send BEGIN and COMMIT through this same query path, and a
 *  statement re-dialled mid-transaction would run in autocommit on the new socket while the
 *  COMMIT then succeeds with nothing to commit. A query in flight when the socket drops still
 *  fails, because the server may already have run it. */
const pgFacade = (make: () => Client): PgConn => {
  let client: Client | null = null
  let connected: Promise<unknown> | null = null
  let closed = false
  let inTransaction = false
  const dial = () => {
    const c = make()
    // A dropped socket must not escalate to an isolate crash; it is marked dead so the next
    // query dials again.
    const dead = () => {
      if (client === c) {
        client = null
        connected = null
      }
    }
    c.on("error", dead)
    c.on("end", dead)
    client = c
    connected = c.connect()
    return c
  }
  const ensure = async (): Promise<Client> => {
    if (closed) throw new Error("connection closed")
    if (!client && inTransaction) {
      inTransaction = false
      throw new Error("connection lost inside a transaction")
    }
    const c = client ?? dial()
    await connected
    return c
  }
  const track = (text: unknown) => {
    if (typeof text !== "string") return
    if (/^\s*(begin|start\s+transaction)\b/i.test(text)) inTransaction = true
    else if (/^\s*(commit|end)\b/i.test(text) || /^\s*rollback(?!\s+to)\b/i.test(text))
      inTransaction = false
  }
  // biome-ignore lint/suspicious/noExplicitAny: pass args straight to node-postgres's overloaded query().
  const query = (async (...args: any[]) => {
    const c = await ensure()
    track(typeof args[0] === "string" ? args[0] : args[0]?.text)
    // biome-ignore lint/suspicious/noExplicitAny: same passthrough.
    return (c.query as (...a: any[]) => unknown)(...args)
  }) as Pool["query"]
  const connect = (async () => {
    await ensure()
    return { query, release: () => {} } as unknown as PoolClient
  }) as Pool["connect"]
  const end = async () => {
    closed = true
    const c = client
    client = null
    connected = null
    if (c) await c.end()
  }
  return { query, connect, end }
}

/** One invocation's Postgres handle — a single Hyperdrive-multiplexed connection. */
export const hyperdriveConn = (hd: Hyperdrive): PgConn =>
  pgFacade(
    () =>
      new Client({
        connectionString: hd.connectionString,
        statement_timeout: 30_000,
        // Client-side too: a half-open socket never delivers the server's timeout.
        query_timeout: 35_000,
        connectionTimeoutMillis: 10_000,
      }),
  )

/** MetaStore for one DO tick: Postgres (fresh connection, released via `close`) when
 *  HYPERDRIVE is bound, else the DO-lifetime-stable D1 binding (no-op close). */
export const tickStore = (env: {
  DB: D1Database
  HYPERDRIVE?: Hyperdrive
}): { store: MetaStore; close: () => Promise<void> } => {
  if (!env.HYPERDRIVE) return { store: createD1Store(env.DB), close: async () => {} }
  const conn = hyperdriveConn(env.HYPERDRIVE)
  return { store: PgMetaStore.fromPool(conn as unknown as Pool), close: () => conn.end() }
}

/** The invocation-scoped connection, bound via `requestPg.run` by the fetch path (worker.ts),
 *  the cron, and the ChatTurn alarm.
 *  `livePgPool` forwards to the in-flight request's connection so the store and Better
 *  Auth — both built once per isolate — never capture a dead socket. */
export const requestPg = new AsyncLocalStorage<PgConn>()

export const livePgPool = new Proxy({} as Pool, {
  get(_target, prop) {
    const conn = requestPg.getStore()
    if (!conn) throw new Error("requestPg: no Postgres connection bound for this request")
    const value = Reflect.get(conn as object, prop)
    return typeof value === "function" ? value.bind(conn) : value
  },
})
