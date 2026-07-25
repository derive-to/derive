import type { BrowserWorker } from "@cloudflare/puppeteer"
import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
  Hyperdrive,
  R2Bucket,
  RateLimit,
  ScheduledController,
} from "@cloudflare/workers-types"
import { createD1Store } from "@derive/db/d1"
import { PgMetaStore } from "@derive/db/pg"
import { PgVectorStore } from "@derive/db/pgvector"
import { R2BlobStore } from "@derive/storage"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/d1"
import { PostgresDialect } from "kysely"
import { createApp } from "./app"
import { type AuthDb, makeAuth } from "./auth-config"
import { authSchema } from "./auth-schema"
import { hyperdriveConn, livePgPool, requestPg } from "./edge-pg"
import type { SendEmailBinding } from "./email-cf"
import { bindingEmbedder, EMBED_DIMENSIONS, type WorkersAiLike } from "./embedder"
import { workspacesBlockingDeletion } from "./lib/account"
import { signupAttributionHook } from "./lib/attribution"
import { customDomainsFromEnv } from "./lib/cloudflare-saas"
import { buildAuthEmail } from "./lib/email"
import { slackFromEnv, subdomainBaseFromEnv, superAdminsFromEnv } from "./lib/env"
import { nativeLimiter } from "./lib/rate-limit"
import { liveD1, requestD1 } from "./lib/request-d1"
import { createDoBackplane, edgeCtx, edgeWaitUntil } from "./realtime-do"
import { PgvectorSearchIndex } from "./search-pgvector"
import { enqueueChannelDelivery } from "./webhooks"

export { PreviewRenderer } from "./preview-do"
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

// The preview renderer DO is a singleton: one fixed name → one DO instance →
// one browser at a time (no parallel-browser billing).
const PREVIEW_NAME = "previews"

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
 * @derive/storage/fs / webhooks-node here — those pull Node built-ins.
 */
export interface Env {
  DB: D1Database
  // Hyperdrive → Postgres (the hosted tier). Bound ⇒ metadata + auth live in
  // Postgres and DB (D1) sits idle (the binding stays because the runtime requires
  // every declared binding to resolve). Unbound ⇒ D1 is the store (the default).
  HYPERDRIVE?: Hyperdrive
  BUCKET: R2Bucket
  // Optional semantic search: Workers AI embeddings (bge-m3) for the dense arm, stored in pgvector
  // in the Hyperdrive Postgres. Bind AI (+ HYPERDRIVE) to add the dense/hybrid arm; omit ⇒ search
  // stays lexical-only, exactly as self-host. Structurally typed (see embedder.ts).
  AI?: WorkersAiLike
  ROOMS: DurableObjectNamespace
  // The webhook outbox drainer DO (a single named instance). Declared in wrangler.toml.
  WEBHOOK_OUTBOX: DurableObjectNamespace
  // The GitHub-sync runner DO (one instance per source, by name). Declared in
  // wrangler.toml. Drives a triggered sync to completion server-side so it survives
  // the user navigating away — the edge counterpart to the Node detached loop.
  SYNC_RUNNER: DurableObjectNamespace
  // The preview renderer DO (a single named instance). Declared in wrangler.toml.
  // Drives sequential screenshot rendering via Cloudflare Browser Rendering.
  // Unbound (local / D1-only deploys) → renderPreviews is false, no jobs enqueue.
  PREVIEW_RENDERER?: DurableObjectNamespace
  // Cloudflare Browser Rendering binding. Unbound ⇒ preview rendering is disabled.
  BROWSER?: BrowserWorker
  // Native per-colo rate-limit bindings (limit + 60s window declared in wrangler.toml
  // [[ratelimits]]). The edge counts against these instead of an in-process Map so a cap
  // holds across isolates within a location. RL_STRICT is shared by the two tight 3/60
  // surfaces (unlock + oauth-register), namespaced by key so their counts stay separate.
  RL_AUTH: RateLimit
  RL_WRITE: RateLimit
  RL_PUBLISH: RateLimit
  RL_COMMENT: RateLimit
  RL_STRICT: RateLimit
  RL_INVITE: RateLimit
  // The static-assets binding: lets the Worker read the SPA shell to inject unfurl
  // meta into /artifacts/:ref (the share URL). Declared in wrangler.toml `[assets] binding`.
  ASSETS: Fetcher
  BASE_URL?: string
  DERIVE_AUTH_SECRET?: string
  DERIVE_TOKEN?: string
  DERIVE_SANDBOX_URL?: string
  DERIVE_SUPERADMIN_EMAILS?: string
  // Base domain for vanity subdomains (domain mode); unset = off.
  DERIVE_SUBDOMAIN_BASE?: string
  // Cloudflare for SaaS (BYO custom domains); all three unset = custom domains off.
  CF_API_TOKEN?: string
  CF_ZONE_ID?: string
  CF_SAAS_FALLBACK_ORIGIN?: string
  // Cloudflare Email Service: notification email transport (declared in wrangler.toml
  // `[[send_email]]`). EMAIL_FROM is the verified from-address. Both unset ⇒ email
  // notifications are skipped on the edge (a delivered no-op in the outbox).
  SEND_EMAIL?: SendEmailBinding
  EMAIL_FROM?: string
  // Slack App (connect flow + Events API). All three set ⇒ Slack on.
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_SIGNING_SECRET?: string
}

/** A cached one-shot fetch of a static asset's text (a marketing page) from the
 *  ASSETS binding, by its canonical URL. Null on any miss — the marketing routes
 *  then fall back to the SPA shell, so a stale build can't 404 the front door. */
function siteFetch(env: Env, baseUrl: string, path: string): () => Promise<string | null> {
  return async () => {
    const hit = siteCache.get(path)
    if (hit !== undefined) return hit
    let text: string | null = null
    try {
      const res = await env.ASSETS.fetch(new URL(path, baseUrl).toString())
      text = res.ok ? await res.text() : null
    } catch {
      text = null
    }
    siteCache.set(path, text)
    return text
  }
}

/** Poke the singleton outbox DO so it drains now (a fresh event) or self-heals (cron). */
function pokeOutbox(env: Env): Promise<unknown> {
  const stub = env.WEBHOOK_OUTBOX.get(env.WEBHOOK_OUTBOX.idFromName(OUTBOX_NAME))
  return stub.fetch("https://outbox/poke", { method: "POST" }).catch(() => {})
}

/** Poke the singleton preview renderer DO so it renders now (a fresh publish) or
 *  self-heals (cron). No-op when PREVIEW_RENDERER is unbound (previews off). */
function pokePreviewRenderer(env: Env): Promise<unknown> {
  if (!env.PREVIEW_RENDERER) return Promise.resolve()
  const stub = env.PREVIEW_RENDERER.get(env.PREVIEW_RENDERER.idFromName(PREVIEW_NAME))
  return stub.fetch("https://previews/poke", { method: "POST" }).catch(() => {})
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
// a deployment). Injected with per-artifact unfurl meta on each /artifacts/:ref request.
let shellCache: string | null = null
// The marketing pages, same lifecycle as the shell: fetched from ASSETS once per
// isolate (immutable for a deployment), keyed by their canonical asset URL.
const siteCache = new Map<string, string | null>()

// The request handler behind both tiers. Split from `fetch` so the pg tier can
// wrap it in a request-scoped pool without indenting the whole body.
const handle = (req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => {
  // Bind THIS request's D1 for the entire handler — including the one-time app/auth
  // construction below — so liveD1 always resolves to a live binding, never a stale one.
  return requestD1.run(env.DB, () => {
    if (!app) {
      // No insecure default on the edge: a hardcoded, public session-signing key
      // would let anyone forge a valid session. The Node path generates+persists
      // one when unset, but a stateless Worker can't, so it must be bound. Fail
      // closed (a 500 on every request) rather than boot with a forgeable secret.
      const secret = env.DERIVE_AUTH_SECRET
      if (!secret || secret.length < 16)
        throw new Error("DERIVE_AUTH_SECRET (>= 16 chars) is required on the edge")
      const baseUrl = env.BASE_URL ?? new URL(req.url).origin
      // Both stores talk to their backend through a request-scoped proxy (liveD1 /
      // livePgPool), never a captured binding or socket — anything captured at
      // construction goes stale once its originating request context is reclaimed
      // and then hangs every query. The proxies always resolve to the in-flight
      // request's handle (bound via requestD1.run / requestPg.run in fetch).
      const meta = env.HYPERDRIVE ? PgMetaStore.fromPool(livePgPool) : createD1Store(liveD1)
      // Auth datastore: Postgres rides Better Auth's Kysely core on an explicit
      // PostgresDialect (declared, not duck-typed — livePgPool is a Proxy). D1 rides
      // Drizzle's first-class D1 driver — the same driver the app store uses, and no
      // kysely-d1; the drizzle adapter defaults transaction:false, so it never issues
      // an interactive transaction to D1.
      const authDb: AuthDb = env.HYPERDRIVE
        ? { dialect: new PostgresDialect({ pool: livePgPool }), type: "postgres" }
        : drizzleAdapter(drizzle(liveD1, { schema: authSchema }), {
            provider: "sqlite",
            schema: authSchema,
          })
      const auth = makeAuth(authDb, baseUrl, secret, {
        usernameTaken: (u) => meta.getUserByUsername(u).then(Boolean),
        // Transactional auth emails ride the same outbox; the WebhookOutbox DO drains it
        // with the Cloudflare Email sender (env.SEND_EMAIL). See webhook-do.ts.
        sendAuthEmail: (kind, input) =>
          enqueueChannelDelivery(meta, "email", `auth.${kind}`, buildAuthEmail(kind, input)),
        blockUserDeletion: async (userId) => {
          const blocking = await workspacesBlockingDeletion(meta, userId)
          return blocking.length
            ? `Transfer ownership or remove the other members of ${blocking.join(", ")} before deleting your account.`
            : null
        },
        purgeUserData: (userId) => meta.deleteUserData(userId),
        // The d_src stamp (lib/attribution.ts) becomes the account's signup_attribution row.
        recordSignupAttribution: signupAttributionHook(meta),
      })
      app = createApp({
        meta,
        // The static operator/CI bearer (isToken). The Node entry wires this via
        // loadConfig(process.env); the edge builds deps by hand from the CF binding and
        // had omitted it, so operator-token auth (reindex, and any DERIVE_TOKEN automation)
        // was dead on prod. Undefined when unset ⇒ isToken stays false, as before.
        token: env.DERIVE_TOKEN,
        blobs: new R2BlobStore(env.BUCKET),
        // Hybrid search's dense arm, embeddings from Workers AI (env.AI). The vectors live in
        // pgvector in the SAME Postgres as metadata (HYPERDRIVE) — the table is created out of band
        // by apply-pg-schema, and PgVectorStore rides the request-scoped livePgPool exactly as the
        // metadata store does. Needs BOTH bindings; a D1 edge (no HYPERDRIVE) or no AI ⇒ undefined ⇒
        // pure-lexical, identical to self-host without an embedder (D1 can't host pgvector anyway).
        search:
          env.AI && env.HYPERDRIVE
            ? new PgvectorSearchIndex(
                bindingEmbedder(env.AI),
                new PgVectorStore(livePgPool, EMBED_DIMENSIONS),
              )
            : undefined,
        backplane: createDoBackplane(env.ROOMS),
        baseUrl,
        auth,
        // Mail-dependent capabilities (password reset, email verification) light up only
        // when the Cloudflare Email binding is present to actually deliver.
        emailEnabled: !!env.SEND_EMAIL,
        // Encrypt stored GitHub PATs at rest with the edge auth secret.
        encryptionKey: secret,
        slack: slackFromEnv(env),
        superAdmins: superAdminsFromEnv(env),
        defaultOrgId: "default",
        subdomainBase: subdomainBaseFromEnv(env),
        customDomains: customDomainsFromEnv(env),
        // Enable rate limiting on the edge, counted by Cloudflare's native per-colo
        // limiter (a plain in-memory Map would cap per isolate only). The native binding's
        // window is fixed at 60s, so unlock / oauth-register run a tighter per-minute cap
        // here than the long-window in-process defaults (see wrangler.toml [[ratelimits]]).
        rateLimit: true,
        rateLimiters: {
          auth: nativeLimiter(env.RL_AUTH, 60),
          // Mail-triggering auth endpoints ride RL_STRICT (tight), namespaced so their
          // count stays separate from unlock / oauth-register on the same binding.
          authEmail: nativeLimiter(env.RL_STRICT, 60, "auth-email"),
          write: nativeLimiter(env.RL_WRITE, 60),
          publish: nativeLimiter(env.RL_PUBLISH, 60),
          comment: nativeLimiter(env.RL_COMMENT, 60),
          // Both ride RL_STRICT (3/60); the prefix keeps their counts separate.
          unlock: nativeLimiter(env.RL_STRICT, 60, "unlock"),
          oauthRegister: nativeLimiter(env.RL_STRICT, 60, "oauth-register"),
          invite: nativeLimiter(env.RL_INVITE, 60),
          // Rides the comment binding, namespaced — same order of magnitude of
          // legitimate use, but its count must not share the comment budget.
          ask: nativeLimiter(env.RL_COMMENT, 60, "ask"),
          // Anonymous draft mints ride RL_STRICT (tight), namespaced from the other
          // strict surfaces. The 60s native window is tighter-per-minute than the
          // in-process hourly cap; both bound the same abuse.
          draftPublish: nativeLimiter(env.RL_STRICT, 60, "draft-publish"),
        },
        // Deliver freshly enqueued events now: poke the outbox DO so its alarm fires,
        // riding waitUntil so the subrequest isn't cancelled when the response is sent.
        pokeWebhooks: () => edgeWaitUntil(pokeOutbox(env)),
        // Run a triggered GitHub sync server-side: poke the per-source runner DO so
        // it mirrors to completion on our servers (tab-independent). waitUntil keeps
        // the poke subrequest alive past the 202 response.
        startSync: (sourceId) => edgeWaitUntil(pokeSync(env, sourceId)),
        // Enable preview rendering only when the Browser Rendering binding is present
        // (hosted Workers). When BROWSER is unbound (self-host / D1-only / local dev),
        // renderPreviews is false so no jobs are enqueued.
        renderPreviews: !!env.BROWSER,
        pokePreviews: () => void edgeWaitUntil(pokePreviewRenderer(env)),
        sandboxOrigin: env.DERIVE_SANDBOX_URL,
        // Read the SPA shell from static assets so /artifacts/:ref can carry unfurl meta.
        // Cached per isolate; null on any miss leaves the shell untouched.
        shellFetch: async () => {
          if (shellCache !== null) return shellCache
          try {
            // Fetch "/" (the canonical shell URL), NOT "/index.html": Static Assets
            // 307-redirects /index.html -> /, so a non-2xx would null the shell and
            // drop unfurl/OG injection on /artifacts/:ref (crawlers/social cards get no meta).
            const res = await env.ASSETS.fetch(new URL("/", baseUrl).toString())
            shellCache = res.ok ? await res.text() : null
          } catch {
            shellCache = null
          }
          return shellCache
        },
        // The marketing front door, always on: `/` for signed-out visitors +
        // `/pricing`, from the web build's site/ pages. Fetched at the CANONICAL asset
        // URLs — html_handling serves site/index.html at /site/ and site/pricing.html
        // at /site/pricing, and redirects the literal filenames, which ASSETS.fetch
        // would surface as a non-2xx. A build without the pages resolves null and
        // the routes fall back to the SPA shell.
        marketing: {
          home: siteFetch(env, baseUrl, "/site/"),
          pricing: siteFetch(env, baseUrl, "/site/pricing"),
        },
      })
    }
    // Run within the per-request context so the DO backplane's publish can waitUntil.
    const ready = app
    return edgeCtx.run(ctx, () => ready.fetch(req))
  })
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
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
  },
}
