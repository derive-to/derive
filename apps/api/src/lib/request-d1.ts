import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database } from "@cloudflare/workers-types"

/**
 * Request-scoped D1 binding.
 *
 * The Worker builds its app (and the Better Auth instance) once at module scope, so
 * anything that captures `env.DB` there is frozen to the *first* request's binding.
 * A Cloudflare binding is tied to the request context that produced it; once that
 * context is reclaimed (minutes after the request ends) every query on the captured
 * binding **hangs forever** with no error. The app's own store is saved only because
 * it's hit constantly (presence heartbeats) and never goes idle long enough; Better
 * Auth's sat idle between logins, went stale, and wedged all auth for the isolate.
 *
 * Fix: never capture a binding. `requestD1` (an AsyncLocalStorage — the same primitive
 * the Worker already uses for `edgeCtx`) holds the *current* request's `env.DB`, set
 * per request in worker.ts via `requestD1.run(env.DB, …)`. `liveD1` is a proxy that
 * forwards every call to whatever binding is bound for the in-flight request, so the
 * D1 client (`drizzle(liveD1)`) always talks to a live, valid binding.
 */
export const requestD1 = new AsyncLocalStorage<D1Database>()

export const liveD1 = new Proxy({} as D1Database, {
  get(_target, prop) {
    const db = requestD1.getStore()
    if (!db) throw new Error("requestD1: no D1 binding bound for this request")
    const value = Reflect.get(db as object, prop)
    return typeof value === "function" ? value.bind(db) : value
  },
})
