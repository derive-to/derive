import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
  R2Bucket,
  RateLimit,
  ScheduledController,
} from "@cloudflare/workers-types"
import { createD1Store } from "@dock/db/d1"
import { R2BlobStore } from "@dock/storage"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/d1"
import { createApp } from "./app"
import { makeAuth } from "./auth-config"
import { authSchema } from "./auth-schema"
import { customDomainsFromEnv } from "./lib/cloudflare-saas"
import { nativeLimiter } from "./lib/rate-limit"
import { liveD1, requestD1 } from "./lib/request-d1"
import { createDoBackplane, edgeCtx } from "./realtime-do"

// The bound Durable Object classes — the realtime room (one per channel), the webhook
// outbox drainer (a single named instance), and the GitHub-sync runner (one per source)
// — re-exported so the Workers runtime can instantiate them (see wrangler.toml
// `durable_objects.bindings`).
export { ArtifactRoom } from "./realtime-do"
export { RepoSyncRunner } from "./sync-runner-do"
export { WebhookOutbox } from "./webhook-do"

// The webhook outbox DO is a singleton: every isolate pokes the same instance by a
// fixed name, so one alarm loop drains the shared outbox.
const OUTBOX_NAME = "outbox"

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
 * needs (SQLITE_AUTH); generate that DDL with gen-auth-schema.ts. See DEPLOY.md.
 *
 * Webhook delivery runs on this tier via the `WebhookOutbox` Durable Object (the edge
 * counterpart to the Node interval worker): the app enqueues to the shared outbox and
 * pokes the DO, whose alarm drains it; a 1-minute cron (`scheduled` below) is the
 * retry/crash backstop. SSRF re-validation uses the edge guard (Cloudflare egress
 * blocks private-space subrequests), so no `node:dns` is pulled into this bundle.
 *
 * Edge/Node separation: this entry imports ONLY `webhook-do` (edge-safe). The Node
 * SSRF guard lives in `webhooks-node` (`node:dns`) and is imported solely by node.ts;
 * `webhooks.ts` itself is runtime-neutral. NEVER import node.ts / config.ts /
 * @dock/storage/fs / webhooks-node here — those pull Node built-ins.
 */
export interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  ROOMS: DurableObjectNamespace
  // The webhook outbox drainer DO (a single named instance). Declared in wrangler.toml.
  WEBHOOK_OUTBOX: DurableObjectNamespace
  // The GitHub-sync runner DO (one instance per source, by name). Declared in
  // wrangler.toml. Drives a triggered sync to completion server-side so it survives
  // the user navigating away — the edge counterpart to the Node detached loop.
  SYNC_RUNNER: DurableObjectNamespace
  // Native per-colo rate-limit bindings (limit + 60s window declared in wrangler.toml
  // [[ratelimits]]). The edge counts against these instead of an in-process Map so a cap
  // holds across isolates within a location. RL_STRICT is shared by the two tight 3/60
  // surfaces (unlock + oauth-register), namespaced by key so their counts stay separate.
  RL_AUTH: RateLimit
  RL_WRITE: RateLimit
  RL_PUBLISH: RateLimit
  RL_COMMENT: RateLimit
  RL_STRICT: RateLimit
  // The static-assets binding: lets the Worker read the SPA shell to inject unfurl
  // meta into /a/:ref (the share URL). Declared in wrangler.toml `[assets] binding`.
  ASSETS: Fetcher
  BASE_URL?: string
  DOCK_AUTH_SECRET?: string
  DOCK_SUPERADMIN_EMAILS?: string
  // Base domain for vanity subdomains (domain mode); unset = off.
  DOCK_SUBDOMAIN_BASE?: string
  // Cloudflare for SaaS (BYO custom domains); all three unset = custom domains off.
  CF_API_TOKEN?: string
  CF_ZONE_ID?: string
  CF_SAAS_FALLBACK_ORIGIN?: string
}

/** Poke the singleton outbox DO so it drains now (a fresh event) or self-heals (cron). */
function pokeOutbox(env: Env): Promise<unknown> {
  const stub = env.WEBHOOK_OUTBOX.get(env.WEBHOOK_OUTBOX.idFromName(OUTBOX_NAME))
  return stub.fetch("https://outbox/poke", { method: "POST" }).catch(() => {})
}

/** Poke the per-source sync runner DO so it starts (or resumes) mirroring on our
 *  servers — tab-independent, so the user can close the page mid-sync. */
function pokeSync(env: Env, sourceId: string): Promise<unknown> {
  const stub = env.SYNC_RUNNER.get(env.SYNC_RUNNER.idFromName(`sync:${sourceId}`))
  const url = `https://sync/start?source=${encodeURIComponent(sourceId)}`
  return stub.fetch(url, { method: "POST" }).catch(() => {})
}

let app: ReturnType<typeof createApp> | null = null
// The SPA shell, fetched from ASSETS once per isolate and reused (it's immutable for
// a deployment). Injected with per-artifact unfurl meta on each /a/:ref request.
let shellCache: string | null = null

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // Bind THIS request's D1 for the entire handler — including the one-time app/auth
    // construction below — so liveD1 always resolves to a live binding, never a stale one.
    return requestD1.run(env.DB, () => {
      if (!app) {
        // No insecure default on the edge: a hardcoded, public session-signing key
        // would let anyone forge a valid session. The Node path generates+persists
        // one when unset, but a stateless Worker can't, so it must be bound. Fail
        // closed (a 500 on every request) rather than boot with a forgeable secret.
        const secret = env.DOCK_AUTH_SECRET
        if (!secret || secret.length < 16)
          throw new Error("DOCK_AUTH_SECRET (>= 16 chars) is required on the edge")
        const baseUrl = env.BASE_URL ?? new URL(req.url).origin
        // Both stores talk to D1 through `liveD1` (the requestD1 ALS proxy), never a
        // captured `env.DB` — a captured binding goes stale once its originating request
        // context is reclaimed and then hangs every query. liveD1 always resolves to the
        // in-flight request's binding (set via requestD1.run below).
        const meta = createD1Store(liveD1)
        // Better Auth on Drizzle's first-class D1 driver (drizzle-orm/d1) — the same
        // driver the app store uses, and no kysely-d1. The drizzle adapter defaults
        // transaction:false, so it never issues an interactive transaction to D1.
        const auth = makeAuth(
          drizzleAdapter(drizzle(liveD1, { schema: authSchema }), {
            provider: "sqlite",
            schema: authSchema,
          }),
          baseUrl,
          secret,
          { usernameTaken: (u) => meta.getUserByUsername(u).then(Boolean) },
        )
        app = createApp({
          meta,
          blobs: new R2BlobStore(env.BUCKET),
          backplane: createDoBackplane(env.ROOMS),
          baseUrl,
          auth,
          // Encrypt stored GitHub PATs at rest with the edge auth secret.
          encryptionKey: secret,
          superAdmins: (env.DOCK_SUPERADMIN_EMAILS ?? "")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
          defaultOrgId: "default",
          subdomainBase:
            env.DOCK_SUBDOMAIN_BASE?.toLowerCase().replace(/^\.+|\.+$/g, "") || undefined,
          customDomains: customDomainsFromEnv(env),
          // Enable rate limiting on the edge, counted by Cloudflare's native per-colo
          // limiter (a plain in-memory Map would cap per isolate only). The native binding's
          // window is fixed at 60s, so unlock / oauth-register run a tighter per-minute cap
          // here than the long-window in-process defaults (see wrangler.toml [[ratelimits]]).
          rateLimit: true,
          rateLimiters: {
            auth: nativeLimiter(env.RL_AUTH, 60),
            write: nativeLimiter(env.RL_WRITE, 60),
            publish: nativeLimiter(env.RL_PUBLISH, 60),
            comment: nativeLimiter(env.RL_COMMENT, 60),
            // Both ride RL_STRICT (3/60); the prefix keeps their counts separate.
            unlock: nativeLimiter(env.RL_STRICT, 60, "unlock"),
            oauthRegister: nativeLimiter(env.RL_STRICT, 60, "oauth-register"),
          },
          // Deliver freshly enqueued events now: poke the outbox DO so its alarm fires,
          // riding waitUntil so the subrequest isn't cancelled when the response is sent.
          pokeWebhooks: () => {
            const p = pokeOutbox(env)
            const c = edgeCtx.getStore()
            if (c) c.waitUntil(p)
            else void p
          },
          // Run a triggered GitHub sync server-side: poke the per-source runner DO so
          // it mirrors to completion on our servers (tab-independent). waitUntil keeps
          // the poke subrequest alive past the 202 response.
          startSync: (sourceId) => {
            const p = pokeSync(env, sourceId)
            const c = edgeCtx.getStore()
            if (c) c.waitUntil(p)
            else void p
          },
          // Read the SPA shell from static assets so /a/:ref can carry unfurl meta.
          // Cached per isolate; null on any miss leaves the shell untouched.
          shellFetch: async () => {
            if (shellCache !== null) return shellCache
            try {
              // Fetch "/" (the canonical shell URL), NOT "/index.html": Static Assets
              // 307-redirects /index.html -> /, so a non-2xx would null the shell and
              // drop unfurl/OG injection on /a/:ref (crawlers/social cards get no meta).
              const res = await env.ASSETS.fetch(new URL("/", baseUrl).toString())
              shellCache = res.ok ? await res.text() : null
            } catch {
              shellCache = null
            }
            return shellCache
          },
        })
      }
      // Run within the per-request context so the DO backplane's publish can waitUntil.
      const ready = app
      return edgeCtx.run(ctx, () => ready.fetch(req))
    })
  },

  // Cron backstop (wrangler.toml `[triggers] crons`): the outbox DO goes idle once it
  // drains, so a retry scheduled during an idle gap (or a missed poke) would wait. This
  // wakes the DO every minute to pick those up — the durable outbox is the source of
  // truth, so this only ever bounds worst-case retry latency; it never double-delivers
  // (the leased claim guarantees that).
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(pokeOutbox(env))
  },
}
