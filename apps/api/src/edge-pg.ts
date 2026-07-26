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
 *  there is no pool to return it to). */
const pgFacade = (client: Client): PgConn => {
  // An invocation socket dropping must not escalate to an isolate crash.
  client.on("error", () => {})
  let connected: Promise<unknown> | null = null
  const ensure = () => {
    connected ??= client.connect()
    return connected
  }
  // biome-ignore lint/suspicious/noExplicitAny: pass args straight to node-postgres's overloaded query().
  const query = (async (...args: any[]) => {
    await ensure()
    // biome-ignore lint/suspicious/noExplicitAny: same passthrough.
    return (client.query as (...a: any[]) => unknown)(...args)
  }) as Pool["query"]
  const connect = (async () => {
    await ensure()
    return { query, release: () => {} } as unknown as PoolClient
  }) as Pool["connect"]
  return { query, connect, end: () => client.end() }
}

/** One invocation's Postgres handle — a single Hyperdrive-multiplexed connection. */
export const hyperdriveConn = (hd: Hyperdrive): PgConn =>
  pgFacade(
    new Client({
      connectionString: hd.connectionString,
      statement_timeout: 30_000,
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

/** The fetch path's request-scoped connection, bound in worker.ts via `requestPg.run`.
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
