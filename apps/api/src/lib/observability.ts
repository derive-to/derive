import { randomUUID } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { log } from "../log"

// Per-request context set by the middleware below + the identity resolvers in
// context.ts, so the access log can name who/what made each request.
declare module "hono" {
  interface ContextVariableMap {
    requestId: string
    actorId?: string
    orgId?: string
  }
}

// Liveness/readiness probes hit every ~15s; access-logging them would drown the
// real signal. (They still get a request id + the X-Request-Id header.)
const SKIP_LOG = new Set(["/healthz", "/readyz"])

/**
 * Tags every request with a stable id (honoring an inbound `X-Request-Id` from a
 * proxy/load balancer, else minting one), echoes it back as a response header, and
 * emits one structured access-log line per request — method, path, status,
 * duration, and the resolved actor/org — so a 500 can be correlated back to who
 * and what triggered it. Registered outermost so it times the whole request.
 */
export const observability = (): MiddlewareHandler => async (c, next) => {
  const requestId = c.req.header("x-request-id") || randomUUID()
  c.set("requestId", requestId)
  c.header("x-request-id", requestId)
  const start = Date.now()
  await next()
  if (SKIP_LOG.has(c.req.path)) return
  log.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
    request_id: requestId,
    actor: c.get("actorId"),
    org: c.get("orgId"),
  })
}
