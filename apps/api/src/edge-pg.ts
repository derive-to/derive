import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database, Hyperdrive } from "@cloudflare/workers-types"
import type { MetaStore } from "@derive/core"
import { createD1Store } from "@derive/db/d1"
import { PgMetaStore } from "@derive/db/pg"
import { Pool } from "pg"

/**
 * Postgres plumbing for the Workers tier (the HYPERDRIVE binding).
 *
 * A Workers TCP socket belongs to the invocation (request or DO event) that
 * opened it — the TCP twin of the stale-binding problem request-d1.ts documents.
 * So pools are invocation-scoped, and cheaply so: node-postgres connects lazily,
 * and the dial goes to the colo-local Hyperdrive proxy, which owns the real
 * server-side connections.
 */

/** One invocation's pool. Callers own the lifecycle: DO ticks end() it when the
 *  tick's work is fully awaited; the fetch path never end()s (see worker.ts) and
 *  relies on the idle timeout + context teardown instead. */
export const hyperdrivePool = (hd: Hyperdrive): Pool => {
  const pool = new Pool({
    connectionString: hd.connectionString,
    max: 5,
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
    // Idle sockets reap themselves, so a pool nobody end()s doesn't hold its
    // invocation open longer than its last query.
    idleTimeoutMillis: 5_000,
  })
  // An idle-socket error on an invocation-scoped pool just means that socket is
  // gone; without a listener node-postgres escalates it to an isolate crash.
  pool.on("error", () => {})
  return pool
}

/** MetaStore for one DO tick: Postgres (fresh pool, released via `close`) when
 *  HYPERDRIVE is bound, else the DO-lifetime-stable D1 binding (no-op close). */
export const tickStore = (env: {
  DB: D1Database
  HYPERDRIVE?: Hyperdrive
}): { store: MetaStore; close: () => Promise<void> } => {
  if (!env.HYPERDRIVE) return { store: createD1Store(env.DB), close: async () => {} }
  const pool = hyperdrivePool(env.HYPERDRIVE)
  return { store: PgMetaStore.fromPool(pool), close: () => pool.end() }
}

/** The fetch path's request-scoped pool, bound in worker.ts via `requestPg.run`.
 *  `livePgPool` forwards to the in-flight request's pool so the store and Better
 *  Auth — both built once per isolate — never capture a dead pool. */
export const requestPg = new AsyncLocalStorage<Pool>()

export const livePgPool = new Proxy({} as Pool, {
  get(_target, prop) {
    const pool = requestPg.getStore()
    if (!pool) throw new Error("requestPg: no Postgres pool bound for this request")
    const value = Reflect.get(pool as object, prop)
    return typeof value === "function" ? value.bind(pool) : value
  },
})
