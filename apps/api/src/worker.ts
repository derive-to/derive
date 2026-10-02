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
  WorkerLoader,
} from "@cloudflare/workers-types"
import { KATEX_VERSION, MERMAID_VERSION } from "@derive/core"
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
import { purgeUserDataAndSyncSeats, workspacesBlockingDeletion } from "./lib/account"
import { makeBillingDriver } from "./lib/billing"
import { customDomainsFromEnv } from "./lib/cloudflare-saas"
import { cloudflareSandbox } from "./lib/code-sandbox-cloudflare"
import { buildAuthEmail } from "./lib/email"
import {
  ortamRuntimeFromEnv,
  slackFromEnv,
  subdomainBaseFromEnv,
  superAdminsFromEnv,
} from "./lib/env"
import { graphAware, graphPass } from "./lib/job-graph"
import { machineDepsFrom, machinePass } from "./lib/job-machine"
import { jobTick } from "./lib/jobs"
import { catalogFromGateway, type GatewayConfig } from "./lib/model-catalog"
import { jobAnnouncer } from "./lib/notify-job"
import { nativeLimiter } from "./lib/rate-limit"
import { liveD1, requestD1 } from "./lib/request-d1"
import { runtimeFailureReason } from "./lib/runtime-diagnostics"
import { isApiPath } from "./lib/serve-web"
import { parseSignupMode, signupPolicy } from "./lib/signup-policy"
import { isServerRenderedPath, isSpaPath, isStaticRootPath } from "./lib/spa-paths"
import { STATIC_NAMESPACE_PREFIXES } from "./lib/static-namespaces"
import { log } from "./log"
import { IMPORTS_POKE_PATH } from "./preview-do"
import { createDoBackplane, edgeCtx, edgeWaitUntil } from "./realtime-do"
import { PgvectorSearchIndex } from "./search-pgvector"
import { bindingSummarizer, type TextGenAiLike } from "./summarizer"
import { enqueueChannelDelivery } from "./webhooks"

export { PreviewRenderer } from "./preview-do"
// The bound Durable Object classes are re-exported so the Workers runtime can
// instantiate them (see wrangler.toml `durable_objects.bindings`).
export { ArtifactRoom } from "./realtime-do"
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
 * needs (SQLITE_AUTH); generate that DDL with gen-auth-schema.ts. See the deployment guide.
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
  DERIVE_ORTAM_RUNNER_PATH?: string
  DERIVE_ORTAM_API_URL?: string
  DERIVE_ORTAM_INTEGRATION_KEY?: string
  DERIVE_MANAGED_RUNS_ALLOWLIST?: string
  DB: D1Database
  /** Isolated, short-lived Workers for the read-only derive_code MCP tool. */
  LOADER: WorkerLoader
  // Hyperdrive → Postgres (the hosted tier). Bound ⇒ metadata + auth live in
  // Postgres and DB (D1) sits idle (the binding stays because the runtime requires
  // every declared binding to resolve). Unbound ⇒ D1 is the store (the default).
  HYPERDRIVE?: Hyperdrive
  /** The commit this worker was deployed from, set by `wrangler deploy --var` in CI. Absent on
   *  a hand-run deploy, which then reports "dev" — honest rather than wrong. */
  BUILD_SHA?: string
  BUCKET: R2Bucket
  // The public site (the derive-to/site repo, private): derive.to's marketing pages,
  // blog and trust files, on their own Worker. Bound only on the hosted deploy;
  // absent ⇒ the application owns the front door (every self-host, previews).
  SITE?: Fetcher
  // Optional semantic search: Workers AI embeddings (bge-m3) for the dense arm, stored in pgvector
  // in the Hyperdrive Postgres. Bind AI (+ HYPERDRIVE) to add the dense/hybrid arm; omit ⇒ search
  // stays lexical-only, exactly as self-host. Structurally typed (see embedder.ts).
  // Widened to the text-generation slice as well: the same binding also writes the one-line
  // version summary every unfurl surface describes an artifact with (summarizer.ts). Unbound ⇒
  // no summaries, exactly as self-host, and every card falls back to its inventory line.
  AI?: WorkersAiLike & TextGenAiLike
  ROOMS: DurableObjectNamespace
  // The webhook outbox drainer DO (a single named instance). Declared in wrangler.toml.
  WEBHOOK_OUTBOX: DurableObjectNamespace
  // The preview renderer DO (a single named instance). Declared in wrangler.toml.
  // Drives sequential screenshot rendering via Cloudflare Browser Rendering.
  // Unbound (local / D1-only deploys) → renderPreviews is false, no jobs enqueue.
  PREVIEW_RENDERER?: DurableObjectNamespace
  // Cloudflare Browser Rendering binding. Unbound ⇒ preview rendering is disabled.
  BROWSER?: BrowserWorker
  // Native per-colo rate-limit bindings (limit + window declared in wrangler.toml
  // [[ratelimits]]). The edge counts against these instead of an in-process Map so a cap
  // holds across isolates within a location. RL_STRICT is shared by the tight 3/60
  // surfaces (auth-email, unlock, oauth-register, draft-publish, access-request mail),
  // namespaced by key so their counts stay separate.
  RL_AUTH: RateLimit
  RL_WRITE: RateLimit
  RL_REALTIME: RateLimit
  RL_PUBLISH: RateLimit
  RL_COMMENT: RateLimit
  RL_STRICT: RateLimit
  RL_INVITE: RateLimit
  RL_ACCESS_REQUEST: RateLimit
  // The static-assets binding: lets the Worker read the SPA shell to inject unfurl
  // meta into /artifacts/:ref (the share URL). Declared in wrangler.toml `[assets] binding`.
  ASSETS: Fetcher
  BASE_URL?: string
  DERIVE_AUTH_SECRET?: string
  DERIVE_TOKEN?: string
  /** OpenAI-compatible model gateway for ATTENDED chat. All three or none — an incomplete
   *  set is treated as unset, so chat stays honestly off rather than 401ing every turn. */
  DERIVE_MODEL_BASE_URL?: string
  DERIVE_MODEL_API_KEY?: string
  DERIVE_MODEL_NAME?: string
  /** Comma-separated ADDITIONAL model ids the same gateway serves, offered to chat as a
   *  choice. Unset ⇒ one model, and no picker. See lib/model-catalog.ts. */
  DERIVE_MODEL_NAMES?: string
  /** Preferred upstream backends, best first, on a gateway that ROUTES one model id to several
   *  of them. Unset ⇒ the gateway routes however it likes. */
  /** "off", or an effort level — how much the model may think before answering. */
  /** Preferred upstream backends, best first, on a gateway that ROUTES one model id to several
   *  of them. Unset ⇒ the gateway routes however it likes. */
  DERIVE_MODEL_PROVIDERS?: string
  /** Eligible upstream backends for live performance routing. Takes precedence over the fixed
   *  DERIVE_MODEL_PROVIDERS order when present. */
  DERIVE_MODEL_AUTO_PROVIDERS?: string
  /** Additional providers as JSON — see parseGatewaysJson. Each carries its own key, models and
   *  backend routing, so a fourth provider is a list entry rather than four more variables. */
  DERIVE_MODEL_GATEWAYS?: string
  /** Workspace ids allowed to enable chat while the gateway above pays. */
  DERIVE_CHAT_ALLOWLIST?: string
  DERIVE_SANDBOX_URL?: string
  DERIVE_SUPERADMIN_EMAILS?: string
  DERIVE_SIGNUP_MODE?: string
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
  // Stripe (billing rail). STRIPE_SECRET_KEY set ⇒ the billing routes light up;
  // STRIPE_WEBHOOK_SECRET is required for /v1/billing/webhook to accept events.
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  // ISO instant after which free-tier boundaries enforce; unset = beta grace.
  DERIVE_BILLING_ENFORCE_AT?: string
  /** PR-preview isolation: keep Browser Rendering available for export jobs while
   *  disabling the unscoped ordinary-preview sweep and queue. */
  DERIVE_EXPORTS_ONLY?: string
  /** PR-preview email seam. The route additionally enforces reserved .test recipients,
   *  and the export worker writes a private capture without touching the outbox. */
  DERIVE_QA_EMAIL_CAPTURE?: string
}

/** The public site over the SITE service binding, when this deployment binds one:
 *  same thread, no network, the request passed through whole so the site sees the
 *  real URL and answers with its own headers. Absent ⇒ undefined ⇒ the application
 *  owns the front door. */
// The cast pair bridges the workers-types/DOM Request dualism: the binding's types
// want the workers Request, Hono hands us the DOM one, and they are the same object
// at runtime. assetResponse sidesteps the same mismatch with a URL string.
const fetchSite = (site: Fetcher, req: Request): Promise<Response> =>
  site.fetch(req as unknown as Parameters<Fetcher["fetch"]>[0]) as unknown as Promise<Response>

function siteUpstream(env: Env): ((req: Request) => Promise<Response>) | undefined {
  const site = env.SITE
  if (!site) return undefined
  return (req: Request) => fetchSite(site, req)
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

// Paper imports run in the preview renderer's class under a name of their own (see
// preview-do.ts): one instance renders and exports, the other fetches papers.
const IMPORTS_NAME = "imports"

/** Poke the paper importer so a fresh import starts now, or a stalled one resumes (cron).
 *  No-op when PREVIEW_RENDERER is unbound. */
function pokeImporter(env: Env): Promise<unknown> {
  if (!env.PREVIEW_RENDERER) return Promise.resolve()
  const stub = env.PREVIEW_RENDERER.get(env.PREVIEW_RENDERER.idFromName(IMPORTS_NAME))
  return stub.fetch(`https://previews${IMPORTS_POKE_PATH}`, { method: "POST" }).catch(() => {})
}

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
// The SPA shell, fetched from ASSETS once per isolate and reused (it's immutable for
// a deployment). Injected with per-artifact unfurl meta on each /artifacts/:ref request.
let shellCache: string | null = null

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
      // Hoisted above makeAuth (rather than built inline down at createApp's `billing:`
      // dep, where it lived before) so the account-deletion hook below and the billing
      // routes share the exact same driver instance instead of constructing two.
      const billing = makeBillingDriver(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
      const auth = makeAuth(authDb, baseUrl, secret, {
        signupAllowed: signupPolicy(parseSignupMode(env.DERIVE_SIGNUP_MODE), secret, meta),
        usernameTaken: (u) => meta.getUserByUsername(u).then(Boolean),
        // Transactional auth emails ride the same outbox; the WebhookOutbox DO drains it
        // with the Cloudflare Email sender (env.SEND_EMAIL). See webhook-do.ts.
        sendAuthEmail: (kind, input) =>
          enqueueChannelDelivery(meta, "email", `auth.${kind}`, buildAuthEmail(kind, input)),
        blockUserDeletion: async (userId) => {
          const blocking = await workspacesBlockingDeletion(meta, userId)
          return blocking.length
            ? `Resolve owned work or workspace ownership in ${blocking.join(", ")} before deleting your account.`
            : null
        },
        // Purge, then heal Stripe seat counts on every workspace the deleted account was
        // billable in (see purgeUserDataAndSyncSeats) — otherwise a vacated editor/owner
        // seat keeps being billed until an unrelated membership change happens to heal it.
        purgeUserData: (userId) => purgeUserDataAndSyncSeats(meta, billing, userId),
      })
      const models = catalogFromGateway(workerGateway(env))
      app = createApp({
        runtime: ortamRuntimeFromEnv(env),
        meta,
        // The static operator/CI bearer (isToken). The Node entry wires this via
        // loadConfig(process.env); the edge builds deps by hand from the CF binding and
        // had omitted it, so operator-token auth (reindex, and any DERIVE_TOKEN automation)
        // was dead on prod. Undefined when unset ⇒ isToken stays false, as before.
        token: env.DERIVE_TOKEN,
        buildId: env.BUILD_SHA,
        // @Derive replies (comments, Slack) need a model here too; without it they answer "no
        // model is configured". Same three vars as self-host, delivered as Worker secrets.
        // Agent jobs are unaffected: they run on their machine's own account.
        // Both from ONE construction: `callModel` is the catalog's default entry, so a lane that
        // picks a model and a lane that does not can never disagree about what "the model" is.
        callModel: models?.resolve(null)?.callModel,
        models: models ?? undefined,
        // The gateway that catalog was built from, so the operator's model library can reach an
        // id the environment never named — same endpoint, same key, no new secret. Without it
        // the library can still relabel and pin a lane, but not ADD. See lib/model-library.ts.
        modelGateway: workerGateway(env),
        // Code Mode stays read-only in mcp-tools/code.ts. The dynamic Worker receives no parent
        // bindings or network access; its find/read calls return through Workers RPC to this host.
        codeSandbox: cloudflareSandbox(env.LOADER, () => {
          const connection = requestPg.getStore()
          return connection ? (call) => requestPg.run(connection, call) : (call) => call()
        }),
        // Multi-tenant, so the allowlist matters here more than anywhere: without it any
        // workspace owner could enable chat and spend Derive's key.
        chatAllowlist: (env.DERIVE_CHAT_ALLOWLIST ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
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
        // Bound on env.AI ALONE, unlike `search` above: a summary is a text call with nowhere to
        // store a vector, so it needs no Hyperdrive and works on a D1 edge that has no pgvector.
        summarize: env.AI ? bindingSummarizer(env.AI) : undefined,
        backplane: createDoBackplane(env.ROOMS),
        baseUrl,
        auth,
        // Mail-dependent capabilities (password reset, email verification) light up only
        // when the Cloudflare Email binding is present to actually deliver.
        emailEnabled: !!env.SEND_EMAIL,
        // Encrypt stored GitHub PATs at rest with the edge auth secret.
        encryptionKey: secret,
        slack: slackFromEnv(env),
        billing,
        billingEnforceAt: env.DERIVE_BILLING_ENFORCE_AT,
        superAdmins: superAdminsFromEnv(env),
        defaultOrgId: "default",
        subdomainBase: subdomainBaseFromEnv(env),
        customDomains: customDomainsFromEnv(env),
        // Enable rate limiting on the edge, counted by Cloudflare's native per-colo
        // limiter (a plain in-memory Map would cap per isolate only). The native binding's
        // window is fixed at 60s, so unlock / oauth-register run a tighter per-minute cap
        // here than the long-window in-process defaults (see wrangler.toml [[ratelimits]]).
        rateLimit: true,
        // THE CEILING THIS TIER ACTUALLY HAS. An attended @Derive turn (a page ask, a Slack
        // mention) runs after the response through waitUntil, which the runtime ends a short
        // while after the response is sent: the isolate stops and the turn writes nothing. This
        // leaves the turn several seconds of live isolate to settle its own job instead. Set only
        // here; Node has no such ceiling.
        attendedTurnBudgetMs: 22_000,
        rateLimiters: {
          auth: nativeLimiter(env.RL_AUTH, 60),
          // Mail-triggering auth endpoints ride RL_STRICT (tight), namespaced so their
          // count stays separate from unlock / oauth-register on the same binding.
          authEmail: nativeLimiter(env.RL_STRICT, 60, "auth-email"),
          write: nativeLimiter(env.RL_WRITE, 60),
          realtime: nativeLimiter(env.RL_REALTIME, 10),
          publish: nativeLimiter(env.RL_PUBLISH, 60),
          comment: nativeLimiter(env.RL_COMMENT, 60),
          // Rides the write binding, namespaced so slot writes and general writes keep
          // separate counts on the same per-colo limiter.
          dynamic: nativeLimiter(env.RL_WRITE, 60, "dynamic"),
          // Both ride RL_STRICT (3/60); the prefix keeps their counts separate.
          unlock: nativeLimiter(env.RL_STRICT, 60, "unlock"),
          oauthRegister: nativeLimiter(env.RL_STRICT, 60, "oauth-register"),
          invite: nativeLimiter(env.RL_INVITE, 60),
          // Rides the comment binding, namespaced — same order of magnitude of
          // legitimate use, but its count must not share the comment budget.
          ask: nativeLimiter(env.RL_COMMENT, 60, "ask"),
          // Anonymous draft mints ride RL_STRICT (3/60s), namespaced from the other
          // strict surfaces. Native periods cap at 60s, so the in-process tier's
          // hour-long window can't be expressed here; the burst cap is the bound.
          draftPublish: nativeLimiter(env.RL_STRICT, 60, "draft-publish"),
          // The in-process tier suppresses a repeat ask for 6 hours; native periods cap
          // at 60s, so the edge approximates that at 1/60s with its own binding rather
          // than riding RL_STRICT (3/60s), which would let a stranger refreshing a dead
          // page re-notify three times a minute.
          accessRequest: nativeLimiter(env.RL_ACCESS_REQUEST, 60, "access-request"),
          // The mail bar, at the same 3/60s as the in-process tier. Deliberately NOT the
          // invite binding: one invite sends one email, one access request fans out to
          // MAX_ACCESS_APPROVERS, so sharing that budget would multiply the real mail
          // ceiling by the fan-out. RL_STRICT is already 3/60; the prefix keeps its count
          // separate from unlock / oauth-register / draft-publish.
          accessRequestMail: nativeLimiter(env.RL_STRICT, 60, "access-request-mail"),
        },
        // Deliver freshly enqueued events now: poke the outbox DO so its alarm fires,
        // riding waitUntil so the subrequest isn't cancelled when the response is sent.
        pokeWebhooks: () => edgeWaitUntil(pokeOutbox(env)),
        // Enable preview rendering only when the Browser Rendering binding is present
        // (hosted Workers). When BROWSER is unbound (self-host / D1-only / local dev),
        // renderPreviews is false so no jobs are enqueued.
        renderPreviews: !!env.BROWSER && env.DERIVE_EXPORTS_ONLY !== "true",
        renderExports: !!env.BROWSER && !!env.PREVIEW_RENDERER,
        qaEmailCapture: env.DERIVE_QA_EMAIL_CAPTURE === "true",
        pokePreviews: () => void edgeWaitUntil(pokePreviewRenderer(env)),
        // Paper imports drain from the renderer class's importer instance. Without the
        // binding nothing would fetch, and an exports-only renderer never runs them.
        imports: !!env.PREVIEW_RENDERER && env.DERIVE_EXPORTS_ONLY !== "true",
        pokeImports: () => void edgeWaitUntil(pokeImporter(env)),
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
        // Browser renderers are copied into static assets at the versions core pins.
        // A miss returns null and the page falls back to source.
        vendorAsset: async (file, library) => {
          try {
            const version = library === "katex" ? KATEX_VERSION : MERMAID_VERSION
            const res = await env.ASSETS.fetch(
              new URL(`/vendor/${library}/${version}/${file}`, baseUrl).toString(),
            )
            return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
          } catch {
            return null
          }
        },
        site: siteUpstream(env),
      })
    }
    // Run within the per-request context so the DO backplane's publish can waitUntil.
    const ready = app
    return edgeCtx.run(ctx, () => ready.fetch(req))
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

/** The operator-configured OpenAI-compatible gateway, or undefined. ALL THREE vars or none: a
 *  base URL with no key 401s every call and a key with no model id sends an empty model, so an
 *  incomplete set is treated as unset. The Node twin is node.ts's `modelGateway`. */
function workerGateway(env: Env): GatewayConfig | undefined {
  const {
    DERIVE_MODEL_BASE_URL: baseUrl,
    DERIVE_MODEL_API_KEY: apiKey,
    DERIVE_MODEL_NAME: model,
    // Optional and additive: more model ids the SAME gateway serves. Unset ⇒ one model, as before.
    DERIVE_MODEL_NAMES: alsoModels,
    // Preferred upstream backends on a gateway that routes; meaningless on one that does not.
    DERIVE_MODEL_PROVIDERS: providers,
    // Eligible backends for live latency/throughput routing; wins over the fixed order above.
    DERIVE_MODEL_AUTO_PROVIDERS: autoProviders,
  } = env
  return baseUrl && apiKey && model
    ? { baseUrl, apiKey, model, alsoModels, providers, autoProviders }
    : undefined
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
          pokeWebhooks: () => edgeWaitUntil(pokeOutbox(env)),
        })
      : undefined
    const graphs = graphAware({ meta, blobs: new R2BlobStore(env.BUCKET), bus, announce })
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
