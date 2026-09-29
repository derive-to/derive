import { AsyncLocalStorage } from "node:async_hooks"
import type { MiddlewareHandler } from "hono"

/**
 * Where a request's time goes, on request: send `X-Derive-Timing: 1` and the response
 * carries a `Server-Timing` entry for every store and blob call it made (in the order they
 * started, each with its start offset), plus any phase a handler marks with {@link span}.
 * Store calls are the cost that local runs hide: on the edge each one is a network round
 * trip, so the list is the critical path. Off by default; without the header nothing is
 * recorded and a store call pays one AsyncLocalStorage lookup.
 */

interface Trace {
  t0: number
  spans: { name: string; start: number; dur: number }[]
}
const current = new AsyncLocalStorage<Trace>()

const record = (name: string, start: number) => {
  const trace = current.getStore()
  if (trace) trace.spans.push({ name, start: start - trace.t0, dur: performance.now() - start })
}

/** Time `work` as a named phase of the traced request (a no-op otherwise). */
export const span = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
  if (!current.getStore()) return work()
  const start = performance.now()
  try {
    return await work()
  } finally {
    record(name, start)
  }
}

/** `target` with each method call recorded as `<label>.<method>` while a traced request
 *  runs. Methods run on the target itself, so private state and `this` are untouched. */
export const traced = <T extends object>(label: string, target: T): T =>
  new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver)
      if (typeof value !== "function" || typeof key !== "string") return value
      return (...args: unknown[]) => {
        if (!current.getStore()) return value.apply(t, args)
        const start = performance.now()
        const out = value.apply(t, args)
        if (out && typeof (out as Promise<unknown>).then === "function")
          return (out as Promise<unknown>).finally(() => record(`${label}.${key}`, start))
        record(`${label}.${key}`, start)
        return out
      }
    },
  })

const token = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_")

/** Record the request when it asks (`X-Derive-Timing`), and answer with what it cost. */
export const requestTrace = (): MiddlewareHandler => async (c, next) => {
  if (!c.req.header("x-derive-timing")) return next()
  const trace: Trace = { t0: performance.now(), spans: [] }
  await current.run(trace, () => next())
  const calls = trace.spans.filter((s) => /^(?:db|blob)\./.test(s.name))
  const entries = [
    `calls;desc="${calls.length} store/blob calls";dur=${calls.reduce((n, s) => n + s.dur, 0).toFixed(1)}`,
    ...trace.spans
      .sort((a, b) => a.start - b.start)
      .map(
        (s, i) => `${i}-${token(s.name)};desc="at ${s.start.toFixed(0)}ms";dur=${s.dur.toFixed(1)}`,
      ),
    `traced;dur=${(performance.now() - trace.t0).toFixed(1)}`,
  ]
  try {
    c.res.headers.append("Server-Timing", entries.join(", "))
    c.res.headers.append("Timing-Allow-Origin", "*")
  } catch {
    // a proxied/streamed response's headers are immutable
  }
}
