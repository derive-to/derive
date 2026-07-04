import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database, Hyperdrive } from "@cloudflare/workers-types"
import type { MetaStore } from "@derive/core"
import { createD1Store } from "@derive/db/d1"
import { PgMetaStore } from "@derive/db/pg"
import { Pool } from "pg"

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE Hyperdrive → Neon Postgres adapter for the Workers tier. Do NOT open a pg
 * connection anywhere else on the edge — go through `hyperdrivePool` /
 * `livePgPool`. Enforced by `scripts/check-hyperdrive-adapter.mjs` (lint:hyperdrive).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The contract, taken straight from the Cloudflare docs. Break any rule and every
 * DB-backed request 500s with "Connection terminated unexpectedly". We have now hit
 * that error twice; the rules below are the fix, quoted so we never re-guess it.
 *
 * 1. ONE connection object PER REQUEST, created inside the request handler — never
 *    module scope, never cached/reused across requests.
 *      Cloudflare, "Connect to Postgres":
 *        "Create a new client instance for each request. Hyperdrive maintains the
 *         underlying database connection pool, so creating a new client is fast."
 *      Cloudflare, Troubleshooting — "Connection terminated unexpectedly":
 *        "The underlying connection was dropped without an explicit .end() call —
 *         for example, when a previous request's context was garbage collected."
 *        Fix: "Create a new database client on every request instead of caching it
 *         in a global variable."
 *    → `hyperdrivePool` is called once per fetch in worker.ts (`requestPg.run`), and
 *      the store + Better Auth (built once per isolate) reach it ONLY through the
 *      `livePgPool` Proxy, which re-resolves to the in-flight request's pool every
 *      call — so nothing captures a socket that outlives its request context.
 *
 * 2. EXPLICITLY `.end()` it when the request is done (worker.ts does this on
 *    `ctx.waitUntil`). Leaking it to GC is the exact trigger quoted above.
 *
 * 3. A `Pool`, not a single `Client`. This app fans out CONCURRENT queries
 *    (`Promise.all` of ~6 `pool.query`s in PgMetaStore stats; the artifact-detail
 *    handler) and runs Kysely `db.transaction`s for Better Auth. A single shared
 *    `Client` serializes every one of those onto ONE socket and interleaves their
 *    wire traffic (and any BEGIN/COMMIT) until the protocol desyncs and the socket
 *    drops — which is what a prior "one Client per request" attempt did to sign-in.
 *    A Pool hands each concurrent query its own connection.
 *
 * 4. `max: 5`. Cloudflare: limit a Worker request to 5 connections (Workers caps
 *    simultaneous external connections). Hyperdrive multiplexes to Neon server-side,
 *    so 5 client sockets is plenty.
 *
 * 5. NO `idleTimeoutMillis`. The idle-socket reaper firing across the request
 *    boundary is itself a "Connection terminated unexpectedly" source in Workers;
 *    let sockets close with the explicit `.end()` / the request context instead.
 *
 * Note: a Cloudflare *account usage limit* ("Usage limit for account exceeded")
 * surfaces through this same path as "Connection terminated unexpectedly" — that is
 * a plan/billing cap (upgrade Workers, or wait for the daily UTC reset), NOT this
 * code. Rule out the account limit in the dashboard before touching this file.
 *
 * Docs:
 *   https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
 *   https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/
 *   https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
 */
export const hyperdrivePool = (hd: Hyperdrive): Pool => {
  const pool = new Pool({
    connectionString: hd.connectionString,
    max: 5,
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
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
 *  Auth — both built once per isolate — never capture a dead pool (rule 1 above). */
export const requestPg = new AsyncLocalStorage<Pool>()

export const livePgPool = new Proxy({} as Pool, {
  get(_target, prop) {
    const pool = requestPg.getStore()
    if (!pool) throw new Error("requestPg: no Postgres pool bound for this request")
    const value = Reflect.get(pool as object, prop)
    return typeof value === "function" ? value.bind(pool) : value
  },
})
