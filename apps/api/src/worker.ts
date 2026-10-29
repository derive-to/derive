import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types"
import { createD1Store } from "@derive/db/d1"
import { PgMetaStore } from "@derive/db/pg"
import { R2BlobStore } from "@derive/storage"
import { createApp } from "./app"
import {
  type Env,
  edgeAppDeps,
  fetchSite,
  pokeImporter,
  pokeOutbox,
  pokePreviewRenderer,
} from "./edge-deps"
import { hyperdriveConn, livePgPool, requestPg } from "./edge-pg"
import { ortamRuntimeFromEnv, subdomainBaseFromEnv } from "./lib/env"
import { graphAware, graphPass } from "./lib/job-graph"
import { machineDepsFrom, machinePass } from "./lib/job-machine"
import { jobTick } from "./lib/jobs"
import { jobAnnouncer } from "./lib/notify-job"
import { liveD1, requestD1 } from "./lib/request-d1"
import { runtimeFailureReason } from "./lib/runtime-diagnostics"
import { isApiPath } from "./lib/serve-web"
import { isServerRenderedPath, isSpaPath, isStaticRootPath } from "./lib/spa-paths"
import { STATIC_NAMESPACE_PREFIXES } from "./lib/static-namespaces"
import { log } from "./log"
import { createDoBackplane, edgeCtx, edgeWaitUntil } from "./realtime-do"

export { ChatTurn } from "./chat-turn-do"
export type { Env } from "./edge-deps"
export { PreviewRenderer } from "./preview-do"
// The bound Durable Object classes are re-exported so the Workers runtime can
// instantiate them (see wrangler.toml `durable_objects.bindings`).
export { ArtifactRoom } from "./realtime-do"
export { WebhookOutbox } from "./webhook-do"

/**
 * Cloudflare Workers entry (experimental edge tier). The same runtime-agnostic
 * `createApp` the Node entry uses, wired to edge adapters: D1 for the MetaStore,
 * R2 for blobs, Better Auth on Drizzle's D1 driver, and a Durable Object backplane
 * for cross-instance realtime fan-out (every client for a channel reaches the same
 * room DO). The Node/self-host path uses the in-process backplane instead, so
 * realtime stays zero-dependency there — the DO is opt-in to this entry.
 *
 * Schema (app + Better Auth) is applied to D1 out of band via `wrangler d1 execute`,
 * not at runtime: D1 forbids the sqlite_master introspection Better Auth's migrator
 * needs (SQLITE_AUTH); generate that DDL with gen-auth-schema.ts. See the deployment guide.
 *
 * Webhook delivery runs on this tier via the `WebhookOutbox` Durable Object (the edge
 * counterpart to the Node interval worker): the app enqueues to the shared outbox and
 * pokes the DO, whose alarm drains it; a 1-minute cron (`scheduled` below) is the
 * retry/crash backstop. SSRF re-validation uses the edge guard (Cloudflare egress
 * blocks private-space subrequests), so no `node:dns` is pulled into this bundle.
 *
 * Built-in chat turns run on the `ChatTurn` Durable Object (chat-turn-do.ts), one per
 * conversation, rather than in a request's after-response window.
 *
 * The bindings (`Env`) and the app deps built from them live in edge-deps.ts, shared with
 * the Durable Objects that need the application context. Edge/Node separation: the Node
 * SSRF guard lives in `webhooks-node` (`node:dns`) and is imported solely by node.ts;
 * `webhooks.ts` itself is runtime-neutral. NEVER import node.ts / config.ts /
 * @derive/storage/fs / webhooks-node here or in edge-deps.ts — those pull Node built-ins.
 */

/** Idle inline edit sessions are finalized through the app's route (see node.ts). Needs the
 *  operator token and the deployment origin; editors' own traffic also sweeps. */
const sweepEditSessions = async (env: Env, ctx: ExecutionContext): Promise<void> => {
  if (!env.DERIVE_TOKEN || !env.BASE_URL) return
  const req = new Request(`${env.BASE_URL}/v1/edit-sessions/sweep`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.DERIVE_TOKEN}` },
  })
  const run = () => handle(req, env, ctx)
  try {
    await (env.HYPERDRIVE ? requestPg.run(hyperdriveConn(env.HYPERDRIVE), run) : run())
  } catch (err) {
    log.warn("edit session sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

let app: ReturnType<typeof createApp> | null = null
// Better Auth's init, until it settles. Null once it has (and before the app exists).
let authReady: Promise<unknown> | null = null
// How long a request waits on that init before giving up on it. Init is a lookup or two
// (well under a second); a stall is a stuck query on the building request's connection,
// which only the 35s query_timeout would end.
const AUTH_INIT_WAIT_MS = 5_000
const AUTH_INIT_STALLED = Symbol("auth init stalled")

const settledWithin = <T>(work: Promise<T>, ms: number): Promise<T | typeof AUTH_INIT_STALLED> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<typeof AUTH_INIT_STALLED>((resolve) => {
    timer = setTimeout(() => resolve(AUTH_INIT_STALLED), ms)
  })
  return Promise.race([work, stalled]).finally(() => clearTimeout(timer))
}

// The request handler behind both tiers. Split from `fetch` so the pg tier can
// wrap it in a request-scoped pool without indenting the whole body. `retried` marks the
// second pass after a stalled init (see the wait below).
const handle = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  retried = false,
): Response | Promise<Response> => {
  // Bind THIS request's D1 for the entire handler — including the one-time app/auth
  // construction below — so liveD1 always resolves to a live binding, never a stale one.
  return requestD1.run(env.DB, () => {
    if (!app) {
      const deps = edgeAppDeps(env, env.BASE_URL ?? new URL(req.url).origin)
      app = createApp(deps)
      // Clears only its own slot: an abandoned init that settles late must not clear the
      // init of the app that replaced it.
      const pending: Promise<unknown> | null =
        deps.auth?.$context.then(() => {
          if (authReady === pending) authReady = null
        }) ?? null
      authReady = pending
    }
    const ready = app
    // Run within the per-request context so the DO backplane's publish can waitUntil.
    const serve = () => edgeCtx.run(ctx, () => ready.fetch(req))
    // Better Auth's init does database work (the OAuth provider seeds its resource rows),
    // and every later auth call in this isolate waits on that one promise. It runs on the
    // connection of the request that built the app, so that request must not finish
    // first: an anonymous page answered before init settles would leave the promise tied
    // to a dead connection, and every sign-in in the isolate would hang. Only requests
    // that arrive before init settles wait. A failed init drops the app so the next
    // request builds it again instead of inheriting the failure.
    //
    // The wait is bounded. An init that has not settled in AUTH_INIT_WAIT_MS is abandoned:
    // the app is dropped and this request retries once, building a fresh app on a fresh
    // connection (the request that built the stalled app is the first to time out, and its
    // own connection is the stuck one). Waiting it out held every request on a new isolate
    // (a whole page load) until the browser gave up. A retry whose init stalls too answers
    // 503 rather than serving into an unsettled init, which is the hang 7e182157 prevents.
    const init = authReady
    if (!init) return serve()
    const started = Date.now()
    return settledWithin(init, AUTH_INIT_WAIT_MS).then(
      (result) => {
        if (result !== AUTH_INIT_STALLED) return serve()
        if (app === ready) {
          app = null
          authReady = null
          log.warn("auth init stalled; rebuilding the app", {
            waited_ms: Date.now() - started,
            retried,
          })
        }
        if (retried)
          return new Response("Service starting, retry shortly", {
            status: 503,
            headers: { "retry-after": "1" },
          })
        const retry = () => handle(req, env, ctx, true)
        return env.HYPERDRIVE ? requestPg.run(hyperdriveConn(env.HYPERDRIVE), retry) : retry()
      },
      (err: unknown) => {
        if (app === ready) {
          app = null
          authReady = null
        }
        throw err
      },
    )
  })
}

// Should this request skip the app entirely and go back to Cloudflare Static
// Assets? True for a static-namespace path on anything that is NOT a vanity host
// — the app host, its app.* alias, workers.dev, and custom domains all keep the
// platform's asset serving exactly as it was before these paths were worker-first.
// A `<label>.<base>` host is the one case that must reach the app: its bundle's
// own /assets files live in domain mode, not the web build. (Custom domains still
// have the shadow for these three prefixes — identifying them needs a DB lookup
// this pre-binding hook can't afford; vanity hosts are the live product surface.)
const staticNamespacePassthrough = (req: Request, env: Env): boolean => {
  const path = new URL(req.url).pathname
  if (!STATIC_NAMESPACE_PREFIXES.some((p) => path.startsWith(`${p}/`))) return false
  const sub = subdomainBaseFromEnv(env)
  if (!sub) return true
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase().split(":")[0] ?? ""
  return host !== sub && !host.endsWith(`.${sub}`)
}

const appHostRequest = (req: Request, env: Env): boolean => {
  const requestHost = new URL(req.url).hostname.toLowerCase()
  const baseHost = new URL(env.BASE_URL ?? req.url).hostname.toLowerCase()
  return (
    requestHost === baseHost ||
    requestHost === `app.${baseHost}` ||
    requestHost.endsWith(".workers.dev")
  )
}

const needsApp = (path: string): boolean => isApiPath(path) || isServerRenderedPath(path)

const assetResponse = (req: Request, env: Env, path: string): Promise<Response> =>
  env.ASSETS.fetch(new URL(path, req.url).toString()) as unknown as Promise<Response>

const staticNotFound = async (req: Request, env: Env): Promise<Response> => {
  const page = await assetResponse(req, env, "/404")
  const headers = new Headers(page.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(req.method === "HEAD" ? null : await page.arrayBuffer(), {
    status: 404,
    headers,
  })
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(req.url)
    const navigation = req.method === "GET" || req.method === "HEAD"
    // The static namespaces (/assets, /brand) are worker-first solely so
    // vanity/draft hosts can reach domain mode (Static Assets routing is host-blind
    // — see serve-web.ts STATIC_NAMESPACE_PREFIXES). Everything that is NOT a
    // vanity host gets the platform's asset serving back verbatim, before any DB
    // binding — the app host, its app.* alias, workers.dev, and every custom
    // domain behave exactly as they did when these paths never hit the Worker.
    // URL-string fetch sidesteps the workers-types/DOM Request dualism; assets
    // are GET/HEAD-only so nothing else is intercepted.
    if (navigation && staticNamespacePassthrough(req, env))
      return assetResponse(req, env, url.pathname)
    if (navigation && isStaticRootPath(url.pathname)) return assetResponse(req, env, url.pathname)
    // Every navigation runs through the Worker so an arbitrary path can return a
    // real 404. Known client-only routes can still take the zero-database fast path
    // and receive the same prerendered shell Cloudflare's SPA fallback used to serve.
    if (navigation && appHostRequest(req, env)) {
      if (isSpaPath(url.pathname) && !needsApp(url.pathname)) return assetResponse(req, env, "/")
      // A navigation the app does not own belongs to the public site (pages,
      // blog, sitemap, trust files) when this deployment has one. Zero DB
      // bindings touched either way; the site's own script sets its headers.
      if (!needsApp(url.pathname))
        return env.SITE ? fetchSite(env.SITE, req) : staticNotFound(req, env)
    }
    // Postgres tier: bind a request-scoped pool (see edge-pg.ts) for livePgPool to
    // resolve. Never end()ed here — `background()` fan-out (context.ts) keeps
    // querying it on waitUntil after the response, so an eager end() would cut
    // notifications/webhooks off mid-flight. Idle sockets reap themselves and the
    // rest dies with the request context.
    if (env.HYPERDRIVE)
      return requestPg.run(hyperdriveConn(env.HYPERDRIVE), () => handle(req, env, ctx))
    return handle(req, env, ctx)
  },

  // Cron backstop (wrangler.toml `[triggers] crons`): the outbox DO goes idle once it
  // drains, so a retry scheduled during an idle gap (or a missed poke) would wait. This
  // wakes the DO every minute to pick those up — the durable outbox is the source of
  // truth, so this only ever bounds worst-case retry latency; it never double-delivers
  // (the leased claim guarantees that). Similarly, the preview renderer DO is woken so
  // a failed render that scheduled a retry during an idle gap still fires on time.
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(pokeOutbox(env))
    ctx.waitUntil(pokePreviewRenderer(env))
    ctx.waitUntil(pokeImporter(env))
    ctx.waitUntil(sweepEditSessions(env, ctx))
    // The job tick: due schedules become jobs, lapsed leases are reclaimed, graph jobs
    // advance, and queued jobs for Derive machines are dispatched.
    ctx.waitUntil(edgeCtx.run(ctx, () => jobTickEdge(env)))
  },
}

/** The job tick on the edge: due schedule windows become jobs, lapsed leases are reclaimed.
 *  Store bindings are request-scoped, so the pass runs inside the same scope the handlers use. */
async function jobTickEdge(env: Env): Promise<void> {
  const pass = async () => {
    const meta = env.HYPERDRIVE ? PgMetaStore.fromPool(livePgPool) : createD1Store(liveD1)
    // A job the tick settles (a lapsed lease lost, a machine that stopped, a graph that
    // finished) tells its people like one a runner settles. The DO backplane's publish needs
    // the cron's execution context, which scheduled() runs this under.
    const bus = createDoBackplane(env.ROOMS)
    const announce = env.BASE_URL
      ? jobAnnouncer({
          meta,
          bus,
          baseUrl: env.BASE_URL,
          encryptionKey: env.DERIVE_AUTH_SECRET,
          pokeWebhooks: () => edgeWaitUntil(pokeOutbox(env)),
        })
      : undefined
    const graphs = graphAware({
      meta,
      blobs: new R2BlobStore(env.BUCKET),
      bus,
      announce,
      cloud: { secret: env.DERIVE_AUTH_SECRET, config: ortamRuntimeFromEnv(env) },
    })
    await jobTick(graphs, new Date())
    await graphPass(graphs)
    const machines = machineDepsFrom(meta, {
      secret: env.DERIVE_AUTH_SECRET,
      server: env.BASE_URL,
      config: ortamRuntimeFromEnv(env),
      bus,
      announce,
    })
    if (machines) await machinePass(machines)
  }
  try {
    await (env.HYPERDRIVE
      ? requestPg.run(hyperdriveConn(env.HYPERDRIVE), pass)
      : requestD1.run(env.DB, pass))
  } catch (error) {
    log.warn("job tick failed", { reason: runtimeFailureReason(error) })
  }
}
