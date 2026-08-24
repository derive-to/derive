import {
  type Action,
  type Actor,
  type AgentRecord,
  type ArtifactRecord,
  type BillingState,
  type BlobStore,
  type BundleManifest,
  type CollectionRecord,
  type ContextRecord,
  can,
  capRole,
  DEFAULT_VERSION_WINDOW_MS,
  effectiveRole,
  FREE_SEAT_LIMIT,
  isAuthenticated,
  isBundleContentType,
  type LinkRole,
  type MembershipRecord,
  type MetaStore,
  maxRole,
  newId,
  type OrgSettings,
  type Principal,
  principalActor,
  principalOwnerId,
  type Role,
  resolveBillingState,
  roleAllows,
  type SearchIndex,
  type SubscriptionRecord,
  type WorkspaceRecord,
} from "@derive/core"
import type { Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { type Auth, mcpAudiences } from "./auth-config"
import { type Backplane, createInProcessBackplane } from "./bus"
import type { AgentLoopInput } from "./lib/agent-loop"
import { isApiToken, verifyApiToken } from "./lib/api-token"
import type { BillingDriver } from "./lib/billing"
import type { CustomDomainProvider } from "./lib/cloudflare-saas"
import type { Sandbox } from "./lib/code-sandbox"
import { answerDeriveMention } from "./lib/comment-turn"
import {
  AGENT_TOKEN_PREFIX,
  safeEqual,
  sha256,
  subjectUnlockCookie,
  unlockCookie,
  unlockToken,
} from "./lib/crypto"
import { fail, VIEWER_COOKIE, WS_COOKIE } from "./lib/http"
import { INSTANCE_SETTINGS_ID } from "./lib/instance-settings"
import { catalogOf, type GatewayConfig, type ModelCatalog } from "./lib/model-catalog"
import { type ModelLibrary, modelSource, readLibrary } from "./lib/model-library"
import { makeOauthAgent } from "./lib/oauth-agent"
import {
  clientIp,
  inMemoryRateLimiters,
  type Limiter,
  type RateLimiters,
  rateLimited,
} from "./lib/rate-limit"
import { verifyWorkToken, workTokenKind } from "./lib/run-token"
import { billableSeatCount, isBillableRole, syncSeats } from "./lib/seats"
import { enqueueSlackChannelEvent } from "./lib/slack-comments"
import { log } from "./log"
import { enqueueRender } from "./previews"
import { edgeCtx } from "./realtime-do"
import type { Summarizer } from "./summarizer"
import { enqueueForEvent, type WebhookEvent } from "./webhooks"

/** The refusal copy for blocked billing actions, keyed by reason. Built from baseUrl
 *  so every surface (HTTP 402/413 bodies, MCP tool errors, session-turn apologies)
 *  hands the human the direct upgrade link. Lives here (not lib/http.ts) because the
 *  MCP surfaces need it too, and both import from context.ts already. No em dashes
 *  (support copy convention). */
const billingBlockCopy = (baseUrl: string) => {
  const billingUrl = `${baseUrl.replace(/\/$/, "")}/settings/billing`
  return {
    needs_team: {
      code: "billing_required",
      message: `This workspace has more than 3 editor seats, so publishing is paused until it upgrades to the Team plan. An owner can upgrade at ${billingUrl}.`,
    },
    lapsed: {
      code: "billing_lapsed",
      message: `This workspace's plan has lapsed, so publishing is paused. Nothing was deleted. An owner can renew at ${billingUrl}.`,
    },
    seat_limit: {
      code: "billing_required",
      message: `Free covers 3 editor seats, so this workspace needs the Team plan to add more editors. An owner can upgrade at ${billingUrl}.`,
    },
    storage: {
      code: "storage_exceeded",
      message: `This workspace is out of storage, so this save was refused. Upgrade for more at ${billingUrl}.`,
    },
  } as const
}

export interface SessionUser {
  id: string
  /** Better Auth account creation time; used only for the short cookieless
   * signup-attribution acceptance window. */
  createdAt: string
  email: string
  name: string | null
  /** Public handle (Profiles & Accounts v1); null until claimed at onboarding. */
  username: string | null
  /** Opt-in: findable in people search when true. Off by default. */
  discoverable: boolean
  /** Coarse team role (free string: Product / Engineering / Design / Marketing / …). */
  profession: string | null
  /** One-line "what you do" blurb shown on the profile + member directory. */
  about: string | null
  /** Finished/skipped first-run onboarding? Server-authoritative (syncs across devices). */
  onboarded: boolean
  /** Has the account's email been verified? Better Auth native field; soft-nudge only
   *  (never gates sign-in), surfaced as a dismissible banner in the app. */
  emailVerified: boolean
  /** Personal Brandprint as a JSON string ({ collectionId? }); null if unset. */
  brandprint: string | null
}

export interface AppDeps {
  meta: MetaStore
  blobs: BlobStore
  /**
   * How long an ATTENDED turn may run before it must settle itself, in ms.
   *
   * Set ONLY where the runtime imposes a deadline the turn cannot see. On Workers an attended
   * turn is detached through `background()` → `waitUntil`, which the runtime ends a short while
   * after the response is sent: the isolate stops, so no timer fires, no catch runs, and the
   * session is left `working` for ever with no answer and no error.
   *
   * So the turn has to give up while it is still ALIVE and can still write its own failure.
   * Unset on Node, where `background()` awaits inline and nothing reclaims the turn.
   */
  attendedTurnBudgetMs?: number
  /** Optional dense/semantic search index. Unset ⇒ workspace search stays lexical-only. Both the
   *  edge and a Postgres self-host inject a pgvector adapter (embeddings from Workers AI or, on
   *  self-host, a local ONNX model); it's absent on SQLite / when no embedder is configured. */
  search?: SearchIndex
  /** Writes the one-line summary each new version is described by on unfurl surfaces
   *  (summarizer.ts). Absent ⇒ no summaries and every card keeps its inventory line, which is
   *  the resting state for self-host and for any deploy without a model binding. */
  summarize?: Summarizer
  /** Realtime relay + presence. In-process when unset (self-host); the Cloudflare
   *  edge entry injects a Durable Object backplane. */
  backplane?: Backplane
  baseUrl: string
  /** The commit this build was cut from, echoed by /healthz.
   *
   *  Exists so "what is actually running?" is answerable from OUTSIDE the deploy pipeline. A
   *  deploy can fail while its CI job is read as green — the job that ships it is one step among
   *  several, and a transient registry error there leaves the previous worker serving with
   *  nothing about the running system to say so. That happened: a fix sat undeployed for two
   *  hours while its symptoms were debugged against code that was never live. Unset ⇒ "dev". */
  buildId?: string
  /** A static token (CI/agents) authorizes writes + gated reads, alongside a login session. */
  token?: string
  /** Passphrase for encrypting stored third-party secrets at rest (GitHub PATs).
   *  The Node + Worker entries pass the auth secret. Unset (e.g. tests) ⇒ tokens
   *  are stored as-is; set ⇒ AES-256-GCM encrypted (see lib/crypto encryptSecret). */
  encryptionKey?: string
  /** Allow the ECHO broker stub for a workspace with no broker plan. Dev and tests only.
   *
   *  Off (the default), such a workspace gets a broker that REFUSES. On, it gets LocalBroker,
   *  whose `execute` returns the caller's own arguments — which is a fixture, not an integration,
   *  and in production is a run that reports success over data that never existed. */
  allowEchoStub?: boolean
  /** The isolate `derive_code` runs model-written JavaScript in. The Node entry passes a worker
   *  thread; the Worker entry passes nothing until Cloudflare's Worker Loader is out of beta, and
   *  the tool simply does not register without one — no runtime sniffing, no half-working tool.
   *  Injected rather than imported so the API never drags `node:worker_threads` into a Workers
   *  bundle, and so a test can supply a fake. */
  codeSandbox?: Sandbox
  /** How an ATTENDED turn calls the model — the chat path, where someone is waiting and the work
   *  runs in this request rather than through the queue. Unattended runs do NOT use this: they
   *  resolve their own credential per run through the payer chain, so who pays never depends on
   *  the process they landed in.
   *
   *  Unset ⇒ chat answers with "no model configured" instead of silently doing nothing. Injected
   *  rather than imported so a test can script it and so no provider choice is baked into the app. */
  callModel?: AgentLoopInput["callModel"]
  /**
   * Whether this deployment's operator gateway pays for unattended Claude runs.
   *
   * `callModel` alone is not enough: it also exists when queued work is executed by a CLI
   * child/container, and that executor cannot use the in-process gateway credential. Entry
   * points set this only when the model loop is the selected unattended substrate. Codex always
   * resolves a Codex plan through the normal payer chain.
   */
  automationOperatorPays?: boolean
  /** EVERY model this deploy can answer an attended turn with, and how to reach each one.
   *
   *  `callModel` above is this catalog's DEFAULT entry — one is built from the other, so the two
   *  can never disagree about what "the model" means. The catalog exists because which model
   *  answers is a choice a person makes mid-conversation, not a property of the process: the
   *  workspace chat resolves the asker's pick through it, and records what answered.
   *
   *  Unset ⇒ no model configured (the same state as `callModel` unset). See lib/model-catalog.
   *
   *  This is the CONFIGURED catalog — the environment's, fixed for the life of the process.
   *  Prefer `ctx.modelsFor()` on any path that answers a turn or offers a choice: it widens this
   *  with the operator's live library, which is the whole point of the library existing. */
  models?: ModelCatalog
  /** The operator's OpenAI-compatible gateway, when one is configured — the SAME value
   *  `models` was built from.
   *
   *  Carried separately because the catalog interface deliberately exposes no way to build an
   *  entry it does not already have, and reaching a model the environment never named is exactly
   *  what the library does. Unset ⇒ the library can relabel and pin, but cannot ADD: an id with
   *  no credential behind it would be offered as a choice that 401s on every turn. */
  modelGateway?: GatewayConfig
  /** Workspace ids allowed to enable chat when `callModel` is set (an operator-paid gateway).
   *  Empty/undefined = no restriction, which is correct for a single-tenant box where the
   *  operator IS the user. On a shared host this is what stops any workspace owner from
   *  enabling chat for themselves and spending the operator's key. */
  chatAllowlist?: string[]
  /** Deprecated migration allow-list. A matching account is bound to immutable
   *  user-id authority only after Better Auth says its email is verified. */
  superAdmins?: string[]
  /** Slack App credentials for the connect flow + inbound Events API. All three set ⇒
   *  the "Add to Slack" connect flow + reply-back are available; unset ⇒ Slack off. */
  slack?: { clientId: string; clientSecret: string; signingSecret: string }
  /** Better Auth instance — mounts /api/auth/* and provides the session. */
  auth?: Auth
  /**
   * Web origins allowed to make credentialed (cookie) calls to /api + /v1.
   * Needed only for the hosted split where the SPA (CDN) and API (container)
   * are on different origins; empty for same-origin self-host or dev proxy.
   */
  webOrigins?: string[]
  /** Record + serve view analytics. Default on; set false to disable entirely. */
  analytics?: boolean
  /** A real transactional email transport is configured (Resend on Node, the Cloudflare
   *  Email binding on the edge) rather than the log-only fallback. Gates the mail-dependent
   *  capabilities (password reset, email verification) in /v1/auth/capabilities, so the SPA
   *  surfaces only the self-serve flows that can actually deliver. */
  emailEnabled?: boolean
  /** Revisions within this window (ms) collapse into one displayed version. */
  versionWindowMs?: number
  /** Workspace role granted to a member who isn't the first user. Default "editor". */
  defaultRole?: Role
  /**
   * The org_id of the bootstrap workspace: the fallback for anonymous requests.
   * Every signed-in user gets their own personal workspace on first login. A
   * real, persisted id, never a magic literal.
   * Defaults to "default" when unset (tests); the Node entry generates + persists
   * one and rekeys any legacy rows onto it.
   */
  defaultOrgId?: string
  /** Per-IP / per-actor rate limiting on auth + mutating routes. Off by default. */
  rateLimit?: boolean
  /**
   * The rate limiters to enforce. Omit for the in-process default (authoritative on a
   * single container — Node / self-host — and used by tests). The edge entry supplies a
   * set backed by Cloudflare's native per-colo limiter (see worker.ts).
   */
  rateLimiters?: RateLimiters
  /**
   * Per-workspace storage backstops (abuse gate). Both default to unlimited so
   * self-host stays open; the hosted tier sets them. maxArtifacts caps how many
   * artifacts a workspace can create; maxBytes caps the summed byte size of all
   * stored versions. Exceeding maxArtifacts → 409, maxBytes → 413.
   */
  maxArtifacts?: number
  maxBytes?: number
  /** Stripe access, injected so tests fake it and self-host omits it. */
  billing?: BillingDriver
  /** ISO instant when free-tier boundaries enforce; unset = beta grace. */
  billingEnforceAt?: string
  /**
   * Per-actor (signed-in user or agent, falling back to IP) write rate limits,
   * in actions per minute. Applied only when rateLimit is on; identity-keyed so
   * one noisy account can't drown the workspace. Default: 30 publishes/min,
   * 60 comments/min.
   */
  publishRate?: number
  commentRate?: number
  /**
   * The web SPA is served from this same process (single-container self-host).
   * When true, the bare `/` placeholder is dropped so the bundled SPA's index
   * owns the app shell; the Node entry wires the static + fallback middleware.
   */
  serveWeb?: boolean
  /**
   * The SPA shell HTML (index.html), when this process serves the bundled web app.
   * Lets the server-rendered `/artifacts/:ref` route return the shell with per-artifact
   * unfurl meta injected, so crawlers (which don't run JS) get OG/Twitter cards.
   * Unset = no injection (API-only, or the edge Worker where assets serve `/artifacts/*`).
   */
  shell?: string
  /**
   * Async shell provider for runtimes that can't read the SPA shell synchronously:
   * the edge Worker fetches `index.html` from its static-assets binding. Used to
   * inject unfurl meta into `/artifacts/:ref` when `shell` (the sync string) isn't set.
   * Returns null if the shell can't be read (the route then serves it untouched).
   */
  shellFetch?: () => Promise<string | null>
  /**
   * gzip the responses. On for the Node/Fly entry (Fly's proxy gives HTTP/2 but
   * doesn't compress); left off for the Cloudflare Worker entry, where the edge
   * already compresses (gzip/brotli) and doubling it up wastes CPU.
   */
  compress?: boolean
  /**
   * A separate origin that serves artifact bytes (`/raw/*`), keeping user HTML
   * off the app's cookie origin — the real isolation wall (CSP sandbox is
   * defense-in-depth). When set, the app origin redirects `/raw/*` here, and
   * this origin serves ONLY raw bytes (never auth, the API, or the app). Use a
   * different registrable domain so session cookies can never reach it. Unset =
   * single-origin self-host, where the iframe `sandbox` attribute is the wall.
   */
  sandboxOrigin?: string
  /**
   * Base domain for vanity subdomains (e.g. "derived.app"). When set, a request to
   * `<label>.<base>` whose host is in the `domain` table serves that artifact at
   * the host root (domain mode). Unset = subdomain serving off.
   */
  subdomainBase?: string
  /**
   * Bring-your-own custom domains (hosted tier). When set, an owner can attach their
   * own hostname to an artifact and Cloudflare for SaaS issues + renews the TLS cert.
   * Unset = custom domains disabled (those endpoints 501). Subdomains work without it.
   */
  customDomains?: CustomDomainProvider
  /**
   * The SPA and API are on different sites (hosted split). Makes first-party
   * cookies we set here — currently the anonymous-viewer id — `SameSite=None;
   * Secure` so they survive the cross-site request, matching the session cookie.
   */
  crossSite?: boolean
  /**
   * Wake the webhook outbox drainer right after an event is enqueued, so delivery is
   * near-instant instead of waiting for the next poll/alarm. Node wires it to the
   * in-process worker's `poke`; the edge entry wires it to the `WebhookOutbox` DO.
   * Unset (e.g. tests) = no poke; the interval/cron backstop still drains the outbox.
   */
  pokeWebhooks?: () => void
  /** Enqueue + drain preview renders (true when a renderer is configured). */
  renderPreviews?: boolean
  /** Wake the preview worker after enqueuing (Workers: poke the PreviewRenderer DO). */
  pokePreviews?: () => void
  /**
   * EXPERIMENTAL hosted runs: start a freshly-created run NOW instead of waiting for the next
   * tick, so "Run now" and a fire-URL feel immediate. Best-effort and fire-and-forget by
   * design — the tick is the guarantee, this is only the latency. Unset (the default, and on
   * every deployment with hosted runs off) ⇒ the run waits to be claimed, unchanged.
   */
  pokeRun?: (runId: string) => void
  /**
   * derive.to's public site (the front door): the marketing pages, the blog, and
   * the trust files, served by their own Worker (the derive-to/site repo, private). A
   * function from request to response because it is the SITE service binding on
   * the edge and an origin proxy (DERIVE_SITE_ORIGIN) on Node. When set, `/`
   * serves the site's landing page to signed-out visitors (signed-in ones keep
   * the SPA) and every navigation the app does not own is answered by the site.
   * Unset (every self-host, tests) ⇒ the application owns the front door and an
   * unknown path gets its 404 page.
   */
  site?: (req: Request) => Promise<Response>
}

/**
 * The shared request-handling context: every helper and singleton a route module
 * needs, built once per app. Route factories destructure what they use from this;
 * route-specific helpers stay in their own module. `AppContext` is inferred from
 * what `buildContext` returns, so the two never drift.
 */
export type AppContext = ReturnType<typeof buildContext>

export function buildContext(deps: AppDeps) {
  const { meta, blobs } = deps
  // Realtime relay + presence. In-process by default (self-host stays zero-config);
  // the edge entry injects a Durable Object backplane. `bus`/`presence` are facades
  // over it, so the publish + heartbeat call sites are unchanged.
  const backplane = deps.backplane ?? createInProcessBackplane()
  const bus = backplane
  const presence = backplane.presence

  const analyticsOn = deps.analytics !== false
  const versionWindowMs = deps.versionWindowMs ?? DEFAULT_VERSION_WINDOW_MS
  const allowOrigins = new Set(deps.webOrigins ?? [])
  const defaultRole: Role = deps.defaultRole ?? "editor"
  // The bootstrap workspace id — always a real value, never a magic
  // literal. The Node entry generates + persists one; tests fall back to this.
  const defaultOrg = deps.defaultOrgId ?? "default"

  // Per-actor limiters on the flood-prone actions, identity-keyed so one account can't
  // drown the workspace even from many IPs. Active only when rate limiting is on; the IP
  // middleware (app.ts) is the per-origin backstop. The same limiter set backs both call
  // sites — app.ts resolves it once and passes it in, so it's a single source of truth.
  // Password unlock is a credential-guessing surface and gets a much tighter cap (5 / 5
  // min in-process; the edge's native binding caps it to a 60s window — see worker.ts).
  const limiters = deps.rateLimiters ?? inMemoryRateLimiters(deps)
  const publishLimiter = deps.rateLimit ? limiters.publish : null
  const commentLimiter = deps.rateLimit ? limiters.comment : null
  const unlockLimiter = deps.rateLimit ? limiters.unlock : null
  const inviteLimiter = deps.rateLimit ? limiters.invite : null
  const askLimiter = deps.rateLimit ? limiters.ask : null

  // Fan an event to subscribed webhooks (enqueues to the outbox; the drainer
  // delivers). Awaited so the row is durable before we respond, but never fatal.
  // When something was enqueued, poke the drainer so it goes out now instead of on
  // the next interval/alarm tick.
  const logEnqueueError =
    (what: string, a: ArtifactRecord, event: WebhookEvent) => (err: unknown) =>
      // Non-fatal (the request still succeeds), but a dropped enqueue means the delivery
      // silently never fires — log it rather than swallow.
      log.error(`${what} enqueue failed`, {
        event,
        artifact: a.short_id,
        error: err instanceof Error ? err.message : String(err),
      })

  const notify = (
    a: ArtifactRecord,
    event: WebhookEvent,
    data: Record<string, unknown>,
  ): Promise<void> => {
    // The two fan-outs are independent: one's failure must not skip the other's drain poke.
    // User-configured webhooks (generic + Slack incoming-webhook rows).
    const webhooks = enqueueForEvent(meta, deps.baseUrl, a, event, data)
      .then((queued) => {
        if (queued > 0) deps.pokeWebhooks?.()
      })
      .catch(logEnqueueError("webhook", a, event))
    // The connected Slack App's channel — a top-level card for artifact-lifecycle events
    // (publishes, review rounds), gated inside the helper on visibility + the channel subscriptions.
    // Skipped entirely when no Slack app is configured on this instance (no wasted lookup).
    const channel = deps.slack
      ? enqueueSlackChannelEvent(meta, deps.baseUrl, a, event, data)
          .then((posted) => {
            if (posted) deps.pokeWebhooks?.()
          })
          .catch(logEnqueueError("slack channel", a, event))
      : Promise.resolve()
    return Promise.all([webhooks, channel]).then(() => {})
  }

  // Enqueue a screenshot render for a newly-published version. Non-fatal (logged on error)
  // and off the request path, but through `background()` rather than orphaned: on Workers that
  // is waitUntil, so the request still returns immediately; on Node it awaits, which is what
  // stops the write outliving the caller. That mattered under the test suite, where an
  // un-awaited enqueue could land AFTER its file finished and write into the next file's
  // freshly recreated schema — a cross-file failure with no plausible local cause.
  // Gated by deps.renderPreviews so self-hosted deployments without a renderer never enqueue.
  const notifyRender = (a: ArtifactRecord, n: number): Promise<void> => {
    if (!deps.renderPreviews) return Promise.resolve()
    return background(
      enqueueRender(meta, a.id, n)
        .then(() => deps.pokePreviews?.())
        .catch((err) =>
          log.error("preview enqueue failed", {
            artifact: a.short_id,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
    )
  }

  // Run after-the-response work without blocking the reply. On Workers the request
  // executionCtx keeps the isolate alive past the sent response via waitUntil; on
  // Node (and tests) there is no such context, so we await inline — local DBs are
  // fast and tests need the work finished before they assert. Used to keep slow,
  // best-effort fan-out (webhook enqueue, mention notifications) off the hot path.
  const background = async (work: Promise<unknown>): Promise<void> => {
    const guarded = Promise.resolve(work).catch((err) =>
      log.error("background task failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    const ec = edgeCtx.getStore()
    if (ec) ec.waitUntil(guarded)
    else await guarded
  }

  const bearer = (c: Context): string => {
    const h = c.req.header("authorization") ?? ""
    return h.startsWith("Bearer ") ? h.slice(7) : ""
  }

  // The signed-in user for this request, memoized like agentFor below: several
  // handlers (actingUser, activeWorkspace, the route itself) resolve the caller
  // more than once, and the session lookup shouldn't run again each time.
  const userCache = new WeakMap<Context, SessionUser | null>()
  const currentUser = async (c: Context): Promise<SessionUser | null> => {
    if (userCache.has(c)) return userCache.get(c) ?? null
    // A BROKEN CREDENTIAL IS NOT A SERVER FAULT. getSession throws on input it cannot make sense
    // of, and with the session cookie cache on there is now a second cookie that can be
    // malformed: a `session_data` of `{}` threw "Error parsing JSON" and every authenticated
    // request 500'd for as long as the client kept sending it. A 500 is both wrong (the caller's
    // cookie is bad, not the server) and sticky — the client has no reason to re-authenticate,
    // so it loops. Unauthenticated is the honest answer and it self-heals: the next sign-in
    // replaces the cookie.
    //
    // Logged at error, not swallowed. This same throw is how a deployment whose secret cannot
    // decrypt the shared JWKS row announces itself, and that diagnosis has to stay findable —
    // it just should not be a 500 on every page.
    const s = deps.auth
      ? await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch((e: unknown) => {
          log.error("session could not be read; treating the request as signed out", {
            error: e instanceof Error ? e.message : String(e),
          })
          return null
        })
      : null
    // `username`/`discoverable` ride the session via Better Auth additionalFields
    // (see auth-config.ts); read them through a narrow cast (optional extras).
    const su = s?.user as
      | {
          id: string
          createdAt: string | Date
          email: string
          name?: string | null
          username?: string | null
          discoverable?: boolean | number | null
          profession?: string | null
          about?: string | null
          onboarded?: boolean | number | null
          emailVerified?: boolean | number | null
          brandprint?: string | null
        }
      | undefined
    const u: SessionUser | null = su
      ? {
          id: su.id,
          createdAt:
            su.createdAt instanceof Date ? su.createdAt.toISOString() : String(su.createdAt),
          email: su.email,
          name: su.name ?? null,
          username: su.username ?? null,
          // Discoverable unless explicitly opted out (on by default; unset = on).
          discoverable: su.discoverable !== false,
          profession: su.profession ?? null,
          about: su.about ?? null,
          // Onboarded only when explicitly set (off by default; unset/null = not yet).
          onboarded: su.onboarded === true || su.onboarded === 1,
          emailVerified: su.emailVerified === true || su.emailVerified === 1,
          brandprint: su.brandprint ?? null,
        }
      : null
    userCache.set(c, u)
    if (u) c.set("actorId", u.id) // tag the access log with the resolved actor
    return u
  }

  // Instance operators: the people who run + host the deployment. The static
  // DERIVE_TOKEN remains an automation credential; human authority is persisted
  // against an immutable Better Auth user id. The email list is migration-only:
  // an already-verified legacy account may bind itself once, but merely submitting
  // a configured address can never grant authority.
  const superAdminEmails = new Set((deps.superAdmins ?? []).map((e) => e.toLowerCase()))
  const isSuperAdmin = async (c: Context): Promise<boolean> => {
    if (isToken(c)) return true
    const me = await currentUser(c)
    if (!me) return false
    if (await meta.isInstanceOperator(me.id)) return true
    if (!me.emailVerified || !superAdminEmails.has(me.email.toLowerCase())) return false
    await meta.addInstanceOperator(me.id)
    return true
  }

  // The one identity resolution for a request (memoized): a typed `Principal` that folds
  // the signed-in user, the agent, and the agent's on-behalf human into a single value —
  // delegation as DATA (the agent Principal carries `onBehalfOf`), not a heuristic split
  // across resolvers + a loose cache. Precedence matches actorFor's authz path: the static
  // token wins, then an agent bearer, then a session, else anonymous. currentUser/agentFor
  // remain the memoized building blocks (and direct route accessors); this composes them.
  const principalCache = new WeakMap<Context, Principal>()
  const resolvePrincipal = async (c: Context): Promise<Principal> => {
    const cached = principalCache.get(c)
    if (cached) return cached
    let p: Principal
    if (isToken(c)) {
      p = { kind: "token" }
    } else {
      const ag = await agentFor(c)
      if (ag) p = { kind: "agent", agent: ag, onBehalfOf: onBehalfOfCache.get(c) ?? null }
      else {
        const me = await currentUser(c)
        p = me
          ? {
              kind: "human",
              user: { id: me.id, email: me.email, name: me.name, username: me.username },
            }
          : { kind: "anonymous" }
      }
    }
    principalCache.set(c, p)
    return p
  }

  // A registered agent acting via its bearer token (memoized per request). An
  // agent is a workspace principal: same authorization path as a member, with
  // its own identity and (default commenter) role. `onBehalfOfCache` records the
  // human the agent acts for, resolved in lockstep and surfaced on the agent Principal.
  const agentCache = new WeakMap<Context, AgentRecord | null>()
  const onBehalfOfCache = new WeakMap<Context, string | null>()
  // The OAuth grant behind an agent principal, when there is one — registered
  // dk_agt_ tokens leave this unset. Managemently-scoped routes read it to tell
  // the two apart: a grant carries the consenting user's scopes; a registered
  // token carries only a runtime role.
  const oauthGrantCache = new WeakMap<
    Context,
    {
      ownerId: string
      ownerName: string | null
      scopeRole: Role
      clientId: string
      boundWorkspaces: string[]
    }
  >()
  // Set when this request's bearer is a minted dkapi_ token — read by the mint to
  // refuse chaining (see isMintedApiToken).
  const mintedApiCache = new WeakMap<Context, boolean>()
  // A run CAPABILITY token's scope: the one run id the bearer may claim/settle/pull for.
  // Set only when agentFor resolved a dkrun_ token; the run endpoints read it to pin the
  // principal to exactly its run (a leaked token can't touch any other run).
  const runScopeCache = new WeakMap<Context, string>()
  // The same, for a session-scoped bearer (the ask lane's half of hosted execution).
  const sessionScopeCache = new WeakMap<Context, string>()
  const agentFor = async (c: Context): Promise<AgentRecord | null> => {
    if (agentCache.has(c)) return agentCache.get(c) ?? null
    const b = bearer(c)
    let a: AgentRecord | null = null
    let owner: string | null = null
    // A MINTED API token (lib/api-token.ts): the agent's own MCP authentication, moved
    // out to its shell so REST is reachable at the level it already holds. It resolves
    // to the SAME principal shape the OAuth grant does — including the grant cache, so
    // management-gated routes treat it identically — but its role is re-capped here
    // against LIVE membership, so demoting or removing the human kills outstanding
    // tokens mid-TTL. Fail-closed: bad signature/expiry, or a user who is no longer a
    // member, resolves to anonymous rather than to a lesser principal.
    if (b && deps.encryptionKey && isApiToken(b)) {
      const claim = await verifyApiToken(deps.encryptionKey, b, Date.now())
      if (claim) {
        const m = await meta.getMembership(claim.orgId, claim.userId)
        if (m) {
          const role = capRole(claim.role, m.role)
          a = {
            id: `oauth:${claim.clientId}`,
            org_id: claim.orgId,
            name: (await meta.getOAuthClientName(claim.clientId)) || claim.clientId || "An agent",
            token: "",
            role,
            created_by: claim.userId,
            hosted: 0,
            managed: 0,
            runs_seen_at: null,
            created_at: new Date().toISOString(),
          }
          owner = claim.userId
          mintedApiCache.set(c, true)
          oauthGrantCache.set(c, {
            ownerId: claim.userId,
            // The capability claim carries no display name — mcp.ts falls back to a
            // getUsers lookup for this one path (minted dkapi_ tokens are rare).
            ownerName: null,
            // The minted role IS the scope ceiling — a token minted for `publish`
            // must not reach management just because its human is an owner.
            scopeRole: claim.role,
            clientId: claim.clientId,
            // Minted per workspace: this token reaches exactly the one it names.
            boundWorkspaces: [claim.orgId],
          })
        }
      }
      agentCache.set(c, a)
      onBehalfOfCache.set(c, owner)
      if (a) c.set("actorId", a.id)
      return a
    }
    const workKind = b ? workTokenKind(b) : null
    if (b && workKind && deps.encryptionKey) {
      // A per-work capability token (unattended execution): signed + expiring, minted at
      // dispatch, never stored. Both kinds resolve to the SAME agent principal a registered
      // token would — the write path needs no special cases — with the work item pinned as
      // this request's scope. Fail-closed at every step: bad signature/expiry, a foreign or
      // already-settled item, or a mismatched agent all resolve to anonymous.
      const claim = await verifyWorkToken(workKind, deps.encryptionKey, b, Date.now())
      if (claim) {
        // Still live? A settled run / session must not keep authorizing writes after the fact,
        // even inside the token's remaining TTL.
        let live = false
        if (workKind === "run") {
          const r = await meta.getRun(claim.id)
          live = !!(
            r &&
            r.agent_id === claim.agentId &&
            r.org_id === claim.orgId &&
            (r.status === "queued" || r.status === "running")
          )
        } else {
          const s = await meta.getSession(claim.id)
          // A session's agent lives on its CONTEXT (sessions have no agent column).
          const cx = s?.context_id ? await meta.getContext(s.context_id) : null
          live = !!(
            s &&
            cx &&
            cx.agent_id === claim.agentId &&
            s.org_id === claim.orgId &&
            (s.state === "open" || s.state === "working")
          )
        }
        if (live) {
          const ag = await meta.getAgent(claim.agentId)
          if (ag && ag.org_id === claim.orgId) {
            a = ag
            owner = ag.created_by ?? null
            if (workKind === "run") runScopeCache.set(c, claim.id)
            else sessionScopeCache.set(c, claim.id)
          }
        }
      }
      agentCache.set(c, a)
      onBehalfOfCache.set(c, owner)
      if (a) c.set("actorId", a.id)
      return a
    }
    if (b && !(deps.token && safeEqual(b, deps.token))) {
      // Either a registered agent token (stored hashed) — acting on behalf of the
      // user who registered it (created_by; null for pre-column agents) — or an
      // OAuth access token from the browser consent flow, which carries the user
      // who authed it. Both resolve to an on-behalf human where one is known.
      // Every registered token is minted with AGENT_TOKEN_PREFIX, so a bearer without
      // it (every OAuth/JWT MCP token) can never match — skip the guaranteed-miss
      // round trip instead of paying it on every one of those calls.
      const reg = b.startsWith(AGENT_TOKEN_PREFIX) ? await meta.getAgentByToken(sha256(b)) : null
      if (reg) {
        a = reg
        owner = reg.created_by ?? null
      } else {
        const o = await oauthAgent(b)
        if (o) {
          a = o.rec
          owner = o.ownerId
          oauthGrantCache.set(c, {
            ownerId: o.ownerId,
            ownerName: o.ownerName,
            scopeRole: o.scopeRole,
            clientId: o.clientId,
            boundWorkspaces: o.boundWorkspaces,
          })
          // An OAuth agent may act in any workspace WITHIN ITS GRANT: an explicit
          // X-Derive-Workspace header, validated against the OWNER's membership,
          // re-homes the agent record itself — so activeWorkspace AND every
          // authorize() comparison agree on the target. Clamped to the grant's
          // scoped set (the consent multi-select): an empty set means all the
          // owner's workspaces, a non-empty one restricts to exactly those. Fail-
          // closed: an unknown, foreign, or out-of-grant id keeps the default
          // workspace. Registered workspace agents (no granting user) never roam.
          // The role is re-capped from the uncapped scope role against the
          // TARGET's membership.
          const want = c.req.header("x-derive-workspace")
          const inGrant = o.boundWorkspaces.length === 0 || o.boundWorkspaces.includes(want ?? "")
          if (want && want !== a.org_id && inGrant) {
            const m = await meta.getMembership(want, owner)
            if (m) a = { ...a, org_id: want, role: capRole(o.scopeRole, m.role) }
          }
        }
      }
    }
    agentCache.set(c, a)
    onBehalfOfCache.set(c, owner)
    if (a) c.set("actorId", a.id)
    return a
  }

  // The human identity behind this request (agent's on-behalf human, or the user
  // themselves; null for anon/token). Keys `personal` comments + publish attribution.
  // A thin read of the one Principal, so the delegation rule lives in exactly one place.
  const privateOwnerId = async (c: Context): Promise<string | null> =>
    principalOwnerId(await resolvePrincipal(c))

  // The human allowed to MANAGE through this request: a signed-in user, or an
  // OAuth grant whose scopes reach manage-grade (scopeRole owner — only
  // derive:manage maps there), acting as its grantor. Registered dk_agt_ tokens
  // are runtime principals (answer sessions, publish charts) and never
  // management ones — a stolen runner token must not be able to rewire or tear
  // down the surfaces it serves. Capability gates still apply on top: the
  // grant's role stays capped by the grantor's actual membership.
  const managementPrincipal = async (c: Context): Promise<string | null> => {
    const me = await currentUser(c)
    if (me) return me.id
    await agentFor(c) // resolves the bearer and fills the grant cache
    const grant = oauthGrantCache.get(c)
    return grant && grant.scopeRole === "owner" ? grant.ownerId : null
  }

  // The OAuth grant behind this request — the consenting user and their UNCAPPED
  // scope role — or null for a registered dk_agt_ token. The MCP layer uses the
  // scope role to re-cap a roamed workspace's role (mirrors agentFor's header
  // re-home), so a single connection can act across every workspace the grantor
  // belongs to. Also carries the grant's scoped workspace SET (the consent
  // multi-select; empty = all) so the MCP layer clamps list_workspaces + switching
  // to it. Resolves the bearer first so the grant cache is filled.
  const oauthGrant = async (
    c: Context,
  ): Promise<{
    ownerId: string
    ownerName: string | null
    scopeRole: Role
    clientId: string
    boundWorkspaces: string[]
  } | null> => {
    await agentFor(c)
    return oauthGrantCache.get(c) ?? null
  }

  // The acting identity (agent or signed-in user) for authorship bylines; null when
  // anonymous. Agents author as their name, never spoofing a person. Also a Principal read.
  const actingUser = async (c: Context): Promise<{ id: string; name: string } | null> =>
    principalActor(await resolvePrincipal(c))

  // The HUMAN byline behind a request, for attributing authored work: a signed-in user is
  // themselves; an agent (the `derive login` CLI, a remote MCP client, or a registered
  // dk_agt_ token) attributes to the human it acts on behalf of — the OAuth grantor or the
  // registrant. Authored work is always the person's, so a byline must NEVER read as the
  // agent's own name: which model/client drove a publish ("Derive CLI", "Claude", an
  // OpenAI-backed tool) is an implementation detail, not the author. Null only when no
  // human is known — anonymous, the static token, or an ownerless agent — and the caller
  // then falls back to actingUser. The agent Principal carries only the human's id, so the
  // display name is resolved here.
  const actingHuman = async (c: Context): Promise<{ id: string; name: string } | null> => {
    const p = await resolvePrincipal(c)
    if (p.kind === "human")
      return { id: p.user.id, name: p.user.name ?? p.user.username ?? p.user.email }
    const owner = principalOwnerId(p)
    if (!owner) return null
    const u = (await meta.getUsers([owner]))[0]
    return { id: owner, name: u?.name ?? u?.username ?? u?.email ?? owner }
  }

  // A stable rate-limit key for the caller: the signed-in user / agent if known,
  // otherwise their IP so anonymous floods are still bounded.
  const actorKey = async (c: Context): Promise<string> => {
    const a = await actingUser(c)
    return a ? `id:${a.id}` : `ip:${clientIp(c)}`
  }

  // Apply a keyed limiter to the caller; returns a 429 Response when over, else
  // null to continue. Helper because publish + comment share it.
  const limited = async (c: Context, limiter: Limiter | null): Promise<Response | null> => {
    if (!limiter) return null
    const r = await limiter(await actorKey(c))
    if (r.ok) return null
    return rateLimited(c, r.retryAfter)
  }
  const billingEnforceAt = deps.billingEnforceAt ? new Date(deps.billingEnforceAt) : null
  // Fail loud on a typo'd date here, the one parse both entrypoints share — a NaN
  // would compare false forever and enforcement day would silently never arrive.
  if (billingEnforceAt && Number.isNaN(billingEnforceAt.getTime()))
    throw new Error(`invalid DERIVE_BILLING_ENFORCE_AT: ${deps.billingEnforceAt}`)
  // Built once per app, from this deployment's baseUrl — every blocked-billing surface
  // (HTTP bodies, MCP tool errors, storage refusals, session-turn apologies) reads from
  // this single record so the copy and the link can never drift between them.
  const blockCopy = billingBlockCopy(deps.baseUrl)
  // The whole billing decision from local state only: the webhook-fed subscription row
  // plus a live editor-seat count. Never calls Stripe — resolveBillingState is pure and
  // DB-free, this just feeds it. `pre` skips the fetches when the caller already
  // holds the row and count (GET /v1/billing), same shape as syncSeats.
  const billingState = async (
    orgId: string,
    pre?: { sub: SubscriptionRecord | null; seatCount: number },
  ): Promise<BillingState> => {
    const [sub, seats] = pre
      ? [pre.sub, pre.seatCount]
      : await Promise.all([meta.getSubscription(orgId), billableSeatCount(meta, orgId)])
    return resolveBillingState({
      subscription: sub,
      seatCount: seats,
      now: new Date(),
      enforceAt: billingEnforceAt,
      fallbackMaxBytes: deps.maxBytes,
    })
  }
  // Null = free to publish; otherwise the refusal copy (code + message) to
  // surface to the caller.
  const billingBlocked = async (
    orgId: string,
  ): Promise<{ code: string; message: string } | null> => {
    const s = await billingState(orgId)
    return s.canPublish || !s.blockedReason ? null : blockCopy[s.blockedReason]
  }
  // The full gate as a route guard, mirroring `limited`: a Response to return when
  // blocked, else null to continue.
  const billingGate = async (c: Context, orgId: string): Promise<Response | null> => {
    const b = await billingBlocked(orgId)
    return b ? fail(c, 402, b.message, { code: b.code }) : null
  }

  // Granting `role` must not add a billable seat the workspace's plan doesn't cover.
  // The target's current role rides along so a re-role of an already-billable member
  // (editor to owner) sails through: it adds nothing. Subscribed workspaces always
  // pass; the grant just becomes a billed seat on the next syncSeats. Beta grace
  // passes: this gate arrives with enforcement, like every other billing gate.
  const seatGrantGate = async (
    c: Context,
    orgId: string,
    role: Role,
    existingRole?: Role | null,
  ): Promise<Response | null> => {
    if (!isBillableRole(role) || (existingRole && isBillableRole(existingRole))) return null
    const [sub, seats] = await Promise.all([
      meta.getSubscription(orgId),
      billableSeatCount(meta, orgId),
    ])
    const s = await billingState(orgId, { sub, seatCount: seats })
    if (s.subscriptionActive || s.betaGrace || seats < FREE_SEAT_LIMIT) return null
    return fail(c, 402, blockCopy.seat_limit.message, { code: blockCopy.seat_limit.code })
  }

  // Show the Made-with-Derive mark, or not? A workspace's whiteLabel toggle only takes
  // effect when it's also ENTITLED (beta, or an active subscription) — the settings
  // check runs first so the billing queries short-circuit away entirely once
  // white-label is off, which is the common case. `pre` skips the settings read when the
  // caller already holds the row (a batched artifactDetail), same shape as billingState:
  // with white-label off that makes this whole call free.
  const effectiveWhiteLabel = async (orgId: string, pre?: OrgSettings): Promise<boolean> =>
    (pre ?? (await meta.getOrgSettings(orgId))).whiteLabel === true &&
    (await billingState(orgId)).whiteLabelEntitled

  // Would storing `incoming` more bytes push THIS workspace over its storage cap?
  // Sums published content (storageBytes) and staged /v1/assets uploads
  // (assetStorageBytes) separately — an asset baked into a bundle can double-count
  // against its staged row, a deliberate over-count: a permanent public /blob/:hash
  // URL must count from the moment it exists, not just once some doc embeds it.
  // The cap itself is now plan-aware (billingState.storageCapBytes) rather than a flat
  // deps.maxBytes comparison: an active subscription's tier cap replaces the operator's
  // fallback, so a Team workspace isn't stuck on the self-host default.
  const overStorage = async (orgId: string, incoming: number): Promise<boolean> => {
    const cap = (await billingState(orgId)).storageCapBytes
    if (!cap) return false
    const [stored, assets] = await Promise.all([
      meta.storageBytes(orgId),
      meta.assetStorageBytes(orgId),
    ])
    return stored + assets + incoming > cap
  }

  // MEMOIZED PER REQUEST + (org, user), same technique as `actorCache` below and for the
  // same reason: `activeWorkspace`'s cookie-validation branch and `ensureMembership` (called
  // from `workspaceRole` and the `/v1/me` route) both ask `getMembership` for the identical
  // pair within one request — every call that resolves a workspace + role paid for it twice.
  // Caches the PROMISE, not the value, so two callers racing before the first resolves still
  // de-dupe to one query.
  const membershipCache = new WeakMap<Context, Map<string, Promise<MembershipRecord | null>>>()
  const cachedMembership = (
    c: Context,
    orgId: string,
    userId: string,
  ): Promise<MembershipRecord | null> => {
    let perRequest = membershipCache.get(c)
    if (!perRequest) {
      perRequest = new Map()
      membershipCache.set(c, perRequest)
    }
    const key = `${orgId}:${userId}`
    const hit = perRequest.get(key)
    if (hit) return hit
    const pending = meta.getMembership(orgId, userId)
    perRequest.set(key, pending)
    return pending
  }

  // MEMOIZED PER REQUEST + user, for the same reason as `cachedMembership` above: the
  // GET /v1/workspaces boot request read the caller's workspace list TWICE — once inside
  // `activeWorkspace` (the branch taken when there is no derive_ws cookie yet, i.e. a
  // first login or any cookie-less client) and once for the response body. On the edge
  // tier that duplicate is a full ~80ms round trip for rows the request already had.
  // Caches the PROMISE, so two callers racing before the first resolves still de-dupe.
  const workspacesCache = new WeakMap<
    Context,
    Map<string, Promise<(WorkspaceRecord & { role: Role })[]>>
  >()
  const cachedWorkspaces = (
    c: Context,
    userId: string,
  ): Promise<(WorkspaceRecord & { role: Role })[]> => {
    let perRequest = workspacesCache.get(c)
    if (!perRequest) {
      perRequest = new Map()
      workspacesCache.set(c, perRequest)
    }
    const hit = perRequest.get(userId)
    if (hit) return hit
    const pending = meta.listWorkspaces(userId)
    perRequest.set(userId, pending)
    return pending
  }

  // Lazy provisioning: the first member of a workspace is its owner; everyone
  // else joins at the default role. Returns the caller's role in that workspace.
  const ensureMembership = async (c: Context, orgId: string, userId: string): Promise<Role> => {
    const existing = await cachedMembership(c, orgId, userId)
    if (existing) return existing.role
    const role: Role = (await meta.countMemberships(orgId)) === 0 ? "owner" : defaultRole
    await meta.setMembership({ id: newId("m"), org_id: orgId, user_id: userId, role })
    // Drop the memoized "no membership" miss — a later read in this same request must see
    // the row just provisioned, not the stale null.
    membershipCache.get(c)?.delete(`${orgId}:${userId}`)
    await syncSeats({ meta, billing: deps.billing }, orgId)
    return role
  }

  // A signed-in user's own workspace, created on demand (multi mode, first login).
  // The id is derived from the user id, not random: an SPA boot fires several
  // requests in parallel, and on a first login each can miss the membership read
  // and provision. setWorkspace/setMembership are upserts, so concurrent
  // provisions converge on one row instead of racing to create siblings.
  const provisionPersonal = async (me: {
    id: string
    email: string
    name: string | null
  }): Promise<string> => {
    const id = `ws_p_${me.id}`
    const base = (me.name ?? me.email).split("@")[0] || "My"
    await meta.setWorkspace(id, `${base}'s Workspace`)
    await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
    return id
  }

  // OAuth access-token resolution (opaque + RFC 8707 JWT) lives in its own module so the
  // jose/JWKS dependency stays out of the context; `agentFor` dispatches to it above.
  const { oauthAgent } = makeOauthAgent({
    meta,
    auth: deps.auth,
    baseUrl: deps.baseUrl,
    // The accepted token audiences (RFC 8707) — the RS-side check that a JWT was issued for
    // THIS server, mirroring the AS-side validAudiences. Same helper, so they can't drift.
    audiences: mcpAudiences(deps.baseUrl),
    provisionPersonal,
  })

  /**
   * `callModel` and `models` are TWO VIEWS OF ONE CONFIGURATION, made so here rather than
   * promised in a comment.
   *
   * Both entry points already build them from one construction — `callModel` is literally
   * `models.resolve(null).callModel` in node.ts and worker.ts — but the invariant lived in those
   * two files, so any deps object that set only `callModel` produced an app where half the lanes
   * could answer and half reported "no model is configured". That is not hypothetical: it is
   * exactly what every lane reading the catalog sees the moment it stops reading `callModel`.
   *
   * So a lone `callModel` becomes a one-entry catalog, and every lane can read the catalog
   * unconditionally. A deploy that configures a gateway is unaffected — it passes `models` and
   * this does nothing.
   */
  const configuredModels =
    deps.models ??
    (deps.callModel
      ? catalogOf([
          {
            // Named, because an answer records which model wrote it and a transcript is read by
            // people. There is no provider id to use: this branch exists precisely because the
            // deploy named no catalog, so "default" is the honest answer rather than a fiction
            // about which model it was.
            id: "default",
            label: "Default",
            isDefault: true,
            build: () => deps.callModel as NonNullable<typeof deps.callModel>,
          },
        ])
      : undefined)

  /**
   * The instance row, read ONCE PER REQUEST.
   *
   * Not a cache with a TTL — a WeakMap on the Hono context, exactly as `currentUser`,
   * `activeWorkspace` and `membership` are memoized here, so a new request always re-reads and
   * an operator's pin still lands on the very next turn. What it removes is re-reading the SAME
   * row several times inside ONE turn: the gate asks whether any model can serve, the turn asks
   * which one is pinned, and the route validates a named id — three questions, one row, and on
   * the hosted tier three Hyperdrive round trips on the path with a person waiting on it.
   *
   * Detached lanes (a comment mention, a Slack mention) have no request to hang this on and
   * pass nothing, which reads once — which is what they did anyway.
   */
  const libCache = new WeakMap<object, Promise<ModelLibrary>>()
  const libraryFor = (c?: object): Promise<ModelLibrary> => {
    if (!c) return readLibrary(meta)
    const hit = libCache.get(c)
    if (hit) return hit
    // The PROMISE is memoized, not the result: two lanes in one request can ask concurrently,
    // and caching only on resolve would let both start their own read.
    const pending = readLibrary(meta)
    libCache.set(c, pending)
    return pending
  }

  // See the doc on the returned property below.
  const modelsFor = modelSource(configuredModels, deps.modelGateway, libraryFor)

  /**
   * A cookie's workspace id, unless it is the RESERVED instance-settings row.
   *
   * That row holds the deploy's model library and is operator-owned; it is not a tenant and
   * must never resolve as one. Nothing today can point a signed-in caller at it — the cookie is
   * only honored when a membership row already exists, and neither switch nor create can mint
   * one for a non-`ws_` id — but "nothing today" is a conjunction of three separate checks in
   * two files, and `ensureMembership` PROVISIONS OWNER on a workspace with no members. So one
   * of those checks weakening turns a settings row into an escalation. This is the guardrail
   * that does not depend on the others, at the one choke point every workspace-scoped route
   * resolves through.
   *
   * An anonymous caller is filtered for the same reason and by the same rule: on an open
   * instance the bootstrap org is trusted, and the reserved id is not that org.
   */
  const reserved = (id: string | undefined): string | undefined =>
    id === INSTANCE_SETTINGS_ID ? undefined : id

  // The caller's active workspace for this request (memoized). Single mode: always
  // the bootstrap org. Multi mode: the derive_ws cookie (validated against
  // membership), else the user's first workspace, provisioning one if they have none.
  const wsCache = new WeakMap<Context, Promise<string>>()
  const activeWorkspace = (c: Context): Promise<string> => {
    const cached = wsCache.get(c)
    if (cached) return cached
    // Cache the PROMISE, not just the answer. Document open starts workspace resolution
    // beside its artifact+grants read; caching only after resolution would let actorFor
    // launch the same membership lookup again while the first one was still in flight.
    const pending = (async () => {
      // An agent acts within its own workspace, never a cookie's.
      const ag = await agentFor(c)
      const me = ag ? null : await currentUser(c)
      let ws: string
      if (ag) {
        // agentFor already re-homed an OAuth agent's org_id when a validated
        // X-Derive-Workspace header was present, so authorize() and this resolver
        // can never disagree on the workspace.
        ws = ag.org_id
      } else if (!me) {
        ws = reserved(getCookie(c, WS_COOKIE)) || defaultOrg
      } else {
        const ck = reserved(getCookie(c, WS_COOKIE))
        if (ck && (await cachedMembership(c, ck, me.id))) ws = ck
        else {
          const mine = await cachedWorkspaces(c, me.id)
          if (mine[0]) ws = mine[0].id
          else {
            ws = await provisionPersonal(me)
            // Drop the memoized EMPTY list: it predates the workspace we just created, and
            // GET /v1/workspaces reads the list again for its body in this same request —
            // it would have answered "you have no workspaces" moments after making one.
            // Exactly the invalidation `ensureMembership` does after provisioning a row.
            workspacesCache.get(c)?.delete(me.id)
          }
        }
      }
      c.set("orgId", ws)
      return ws
    })()
    wsCache.set(c, pending)
    return pending
  }
  // Persist the active-workspace choice. Same cross-site handling as the viewer
  // cookie so it survives the hosted SPA↔API split.
  const setWsCookie = (c: Context, id: string): void =>
    setCookie(c, WS_COOKIE, id, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: true,
      sameSite: deps.crossSite ? "None" : "Lax",
      secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
    })

  // A stable id for an anonymous viewer, kept in a long-lived first-party cookie
  // so the same browser counts as one viewer across opens (unique-view counts +
  // a stable presence handle). Minted on first sight. Same SameSite/secure rules
  // as the workspace cookie so it survives the hosted cross-site split.
  const anonViewerId = (c: Context): string => {
    let vid = getCookie(c, VIEWER_COOKIE)
    if (!vid) {
      vid = newId("anon")
      setCookie(c, VIEWER_COOKIE, vid, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        httpOnly: true,
        sameSite: deps.crossSite ? "None" : "Lax",
        secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
      })
    }
    return vid
  }

  // The PRESENCE identity for an anonymous viewer, taken from a stable token the CLIENT
  // carries (localStorage) and echoes on every realtime call — the SSE stream (`?g=`), the
  // heartbeat, and cursor frames. Fixing identity client-side (the PartyKit/Liveblocks
  // model) is what keeps one browser to ONE presence row: all of a page's concurrent
  // realtime requests carry the same token, so there is no cookie set-and-read race to fan
  // a single tab out into several phantom viewers. NON-authoritative and used only for the
  // display handle/roster key — the caller's role always comes from real auth (see
  // deriveViewer), never this. The `anon_` namespace + charset strip mean a client value
  // can't collide with a real `usr_`/session id (no impersonating a signed-in user); it CAN
  // collide with another anonymous viewer's handle, which is cosmetic and accepted. The
  // web mirror `guestPresenceId()` (lib/guest-id.ts) must reproduce this exact transform so
  // an anon viewer recognises its own row. Falls back to the cookie-minted id for a caller
  // that sends no token (an older client, or curl). The `derive_vid` cookie now serves
  // unique-view analytics only (see analytics.ts).
  const guestViewerId = (c: Context): string => {
    const clean = (c.req.query("g") ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
    return clean ? `anon_${clean}` : anonViewerId(c)
  }

  // MEMOIZED PER REQUEST + ARTIFACT, exactly like `currentUser` above and for the same reason:
  // handlers authorize the same artifact more than once, and every miss costs THREE round trips
  // (membership, artifact member, collection roles).
  //
  // Opening a chat session authorizes twice — `read`, then `publish` — and separately reads the
  // membership a third time, so ONE request made eleven sequential queries against Postgres, of
  // which the same membership row was fetched three times and the artifact-member and
  // collection-role rows twice each. On the hosted edge those cost ~100-900ms apiece.
  //
  // Safe because an Actor is a pure function of (principal, artifact), and both are fixed for
  // the life of a request: nothing in a handler can change a role underneath itself, and a role
  // changed by someone else is picked up by the next request. Keyed by Context, so it dies with
  // the request rather than outliving a revoked share.
  const actorCache = new WeakMap<Context, Map<string, Promise<Actor>>>()
  /** `pre` is grants a caller ALREADY has in hand, from a read that fetched the artifact
   *  and the caller's standing on it together (`artifactWithGrants`). It is a shortcut
   *  around the query, never around the decision — and it is honoured ONLY when the
   *  request's principal turns out to be exactly the user it was resolved for. Anything
   *  else (an agent bearer alongside a session cookie, a token, an anonymous visitor)
   *  ignores it and takes the normal path, so a mis-supplied `pre` can cost a wasted
   *  query but cannot produce the wrong actor. */
  type PreGrants = {
    userId: string
    orgRole: Role | null
    artifactRoles: Role[]
    portableArtifactRoles: Role[]
  }

  const actorFor = (c: Context, a: ArtifactRecord, pre?: PreGrants): Promise<Actor> => {
    let perArtifact = actorCache.get(c)
    if (!perArtifact) {
      perArtifact = new Map()
      actorCache.set(c, perArtifact)
    }
    // Cache the PROMISE, not the resolved value: two authorize() calls that both start before
    // the first resolves would otherwise both miss and both issue the three queries.
    const hit = perArtifact.get(a.id)
    if (hit) return hit
    const pending = resolveActor(c, a, pre)
    perArtifact.set(a.id, pending)
    return pending
  }

  const openCollectionLinkRole = (
    c: Context,
    col: CollectionRecord,
  ): Exclude<LinkRole, "none"> | null => {
    if (col.link_role === "none") return null
    if (!col.password_hash) return col.link_role
    const unlocked = safeEqual(
      getCookie(c, subjectUnlockCookie("collection", col.id)) ?? "",
      unlockToken(col.id, col.password_hash),
    )
    return unlocked ? col.link_role : null
  }

  // A collection's world link is an additive grant on every artifact it contains.
  // Resolve all containing collections in one join, then reuse maxRole/effectiveRole;
  // there is no second collection-specific permission ladder.
  const inheritedCollectionLinkRole = async (
    c: Context,
    artifactId: string,
  ): Promise<Exclude<LinkRole, "none"> | null> => {
    const roles = (await meta.collectionsForArtifact(artifactId))
      .map((col) => openCollectionLinkRole(c, col))
      .filter((role): role is Exclude<LinkRole, "none"> => role !== null)
    const best = maxRole(...roles)
    return best === "viewer" || best === "commenter" || best === "editor" ? best : null
  }

  // Collection links top out at editor for signed-in callers and viewer for
  // anonymous callers. Skip their join whenever that ceiling cannot change the
  // already-resolved role; collection-only access pays the lookup on demand.
  const withInheritedCollectionLink = async (
    c: Context,
    a: ArtifactRecord,
    actor: Actor,
  ): Promise<Actor> => {
    if (actor.kind === "token") return actor
    const direct = effectiveRole(actor, a.workspace_access, a.link_role)
    if (direct === "owner" || direct === "editor" || (actor.kind === "anon" && direct === "viewer"))
      return actor
    return { ...actor, inheritedLinkRole: await inheritedCollectionLinkRole(c, a.id) }
  }

  const resolveActor = async (c: Context, a: ArtifactRecord, pre?: PreGrants): Promise<Actor> => {
    // A password on the artifact is a lock on its public link. Has this visitor
    // entered it? The unlock cookie's value is derived from the server-only
    // hash, so it can't be forged.
    const hash = a.password_hash
    const locked = !!hash
    const unlocked =
      !!hash && safeEqual(getCookie(c, unlockCookie(a.short_id)) ?? "", unlockToken(a.id, hash))
    // Narrow the one Principal to this artifact's Actor (the can() input).
    const p = await resolvePrincipal(c)
    if (p.kind === "token") return { kind: "token" }
    if (p.kind === "anonymous")
      return withInheritedCollectionLink(c, a, { kind: "anon", locked, unlocked })
    if (p.kind === "agent") {
      const ag = p.agent
      // An agent acts AS ITS REGISTRANT, capped at its registered role and bound
      // to its home workspace. Its per-artifact standing DERIVES from the human's
      // member rows — agents hold no rows of their own (an agent in a share
      // roster is a category error: you share with people; agents borrow). The
      // cap means no agent reaches `manage` (registration tops out at editor),
      // and the workspace binding keeps tokens scoped per ADR-0001. Rows written
      // to an agent id before this model (or by hand) still count, uncapped —
      // they were explicit grants.
      const own = await meta.getArtifactMember(a.id, ag.id)
      let derived: Role | null = null
      const ownerId = p.onBehalfOf
      if (ownerId && ag.org_id === a.org_id) {
        const m = await meta.getArtifactMember(a.id, ownerId)
        const cRoles = await meta.collectionRolesForArtifact(a.id, ownerId)
        derived = capRole(maxRole(m?.role ?? null, ...cRoles), ag.role)
      }
      const orgRole = ag.org_id === a.org_id ? ag.role : null
      // Historical rows written directly to an agent id remain explicit grants, but
      // ownership is workspace-bound even for that legacy shape. Lower collaborator
      // roles remain portable, matching human shares.
      const ownRole = ag.org_id === a.org_id || own?.role !== "owner" ? (own?.role ?? null) : null
      return withInheritedCollectionLink(c, a, {
        kind: "user",
        userId: ag.id,
        artifactRole: maxRole(ownRole, derived),
        orgRole,
        locked,
      })
    }
    // A signed-in human. Workspace authority belongs to the ACTIVE workspace, not
    // merely to the account: switching away drops the artifact workspace's seat and
    // every owner-level artifact/collection grant. Deliberate lower collaborator
    // shares remain portable, as does the separately-evaluated world link.
    const me = p.user
    const workspaceActive = (await activeWorkspace(c)) === a.org_id
    // ONE ROUND TRIP WHERE THE STORE CAN, four where it cannot. The reads below are the
    // membership, the per-artifact share and the collection shares — and the last is itself two
    // queries, so this is four trips to decide one boolean, on every authorize. A store that can
    // answer it in a single statement implements `artifactGrants`; the fallback is the original
    // code, unchanged, so a store without it behaves exactly as before.
    //
    // Both paths feed the SAME maxRole/can(): the fast path changes how the inputs arrive, never
    // what they are. artifact-grants-parity.test.ts asserts the two agree.
    // Already resolved alongside the artifact itself — same inputs, one round trip earlier.
    // The identity check is the guard described on PreGrants.
    if (pre && pre.userId === me.id)
      return withInheritedCollectionLink(c, a, {
        kind: "user",
        userId: me.id,
        artifactRole: maxRole(
          null,
          ...(workspaceActive ? pre.artifactRoles : pre.portableArtifactRoles),
        ),
        orgRole: workspaceActive ? pre.orgRole : null,
        locked,
        unlocked,
      })
    if (meta.artifactGrants) {
      const g = await meta.artifactGrants(a.id, a.org_id, me.id)
      return withInheritedCollectionLink(c, a, {
        kind: "user",
        userId: me.id,
        artifactRole: maxRole(
          null,
          ...(workspaceActive ? g.artifactRoles : g.portableArtifactRoles),
        ),
        orgRole: workspaceActive ? g.orgRole : null,
        locked,
        unlocked,
      })
    }
    const orgRole = workspaceActive
      ? ((await meta.getMembership(a.org_id, me.id))?.role ?? null)
      : null
    const am = await meta.getArtifactMember(a.id, me.id)
    // A collection share grants its role on every artifact in the collection,
    // folded in alongside any per-artifact share (the higher wins).
    const cRoles = await meta.collectionRolesForArtifact(a.id, me.id, {
      includeWorkspaceSeats: workspaceActive,
    })
    const portable = (role: Role | null | undefined): Role | null =>
      workspaceActive || role !== "owner" ? (role ?? null) : null
    const artifactRole = maxRole(portable(am?.role), ...cRoles.map(portable))
    return withInheritedCollectionLink(c, a, {
      kind: "user",
      userId: me.id,
      artifactRole,
      orgRole,
      locked,
      unlocked,
    })
  }

  /** Authorize an action against a specific artifact. Access is the max of three
   *  grants: an explicit share, the workspace seat (when workspace_access=member),
   *  and the world link (link_role, clamped to view for anonymous holders and gated
   *  by unlock when the link is password-locked). See effectiveRole. */
  const authorize = async (c: Context, action: Action, a: ArtifactRecord): Promise<boolean> => {
    const actor = await actorFor(c, a)
    return can(actor, action, a.workspace_access, a.link_role)
  }

  /** Authorize using STANDING only — an explicit share or the workspace seat, NOT
   *  the world link (link_role forced to `none`). The reach controls (change access,
   *  toggle the lock) gate on this so the link's own grant can't bootstrap widening
   *  the link/listing or clearing the password: a random signed-in URL holder with an
   *  editor link edits content, but only a member or an explicit sharee re-shares. */
  const authorizeStanding = (c: Context, action: Action, a: ArtifactRecord): Promise<boolean> =>
    actorFor(c, a).then((actor) =>
      can({ ...actor, inheritedLinkRole: null }, action, a.workspace_access, "none"),
    )

  /** Authorize an EXPLICIT user (not the request's principal) against an artifact,
   *  on STANDING only — their explicit share + collection shares + workspace seat,
   *  never the world link. The tokened publish path needs this: the request carries
   *  no session (a capability token authorized it out of band), so we re-check the
   *  BOUND user's real rights on the target — live, at spend time, so a revoked share
   *  or lost seat kills the token. Mirrors actorFor's human branch; standing (not the
   *  link) is what a publisher must hold, so a private artifact's viewer-share can't
   *  publish even when its holder is a workspace editor. */
  const authorizeUserStanding = async (
    userId: string,
    action: Action,
    a: ArtifactRecord,
  ): Promise<boolean> => {
    const orgRole = (await meta.getMembership(a.org_id, userId))?.role ?? null
    const am = await meta.getArtifactMember(a.id, userId)
    const cRoles = await meta.collectionRolesForArtifact(a.id, userId)
    const artifactRole = maxRole(am?.role ?? null, ...cRoles)
    return can({ kind: "user", userId, artifactRole, orgRole }, action, a.workspace_access, "none")
  }

  /**
   * True when the caller is an anonymous visitor — they may view public content
   * but nothing collaborative (comments, member list, analytics).
   * Anonymous is never a trusted principal, so this is a simple kind check. Use
   * as a post-`read` gate to hide collaboration from public link-visitors without
   * touching the role model.
   */
  const anonLocked = async (c: Context, a: ArtifactRecord): Promise<boolean> => {
    const actor = await actorFor(c, a)
    return actor.kind === "anon"
  }

  /**
   * Is the caller an authenticated principal — a static token, a registered
   * agent, or a signed-in user — as opposed to an anonymous visitor? The single
   * source of truth for "not anonymous", used by the global anonymous-write
   * lockdown so a new mutating route can never accidentally be exposed to anon.
   */
  const isPrincipal = async (c: Context): Promise<boolean> =>
    isAuthenticated(await resolvePrincipal(c))

  /** The caller's role in their active workspace (creating artifacts, settings). */
  const workspaceRole = async (c: Context): Promise<Role | null> => {
    if (isToken(c)) return "owner"
    const ag = await agentFor(c)
    if (ag) return ag.role
    const me = await currentUser(c)
    if (!me) return null
    return ensureMembership(c, await activeWorkspace(c), me.id)
  }
  const workspaceCan = async (c: Context, action: Action): Promise<boolean> => {
    const r = await workspaceRole(c)
    return r !== null && roleAllows(r, action)
  }

  /**
   * Source text of a stored version (entry document for bundles); null if missing.
   */
  const sourceText = async (content: {
    blob_key: string
    content_type: string
  }): Promise<string | null> => {
    let data: Uint8Array | null
    if (isBundleContentType(content.content_type)) {
      const manifestBytes = await blobs.get(content.blob_key)
      if (!manifestBytes) return null
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
      const entryFile = manifest.files[manifest.entry]
      if (!entryFile) return null
      data = await blobs.get(entryFile.key)
    } else {
      data = await blobs.get(content.blob_key)
    }
    return data ? new TextDecoder().decode(data) : null
  }

  // A caller's role on a collection: the static token is owner; otherwise the
  // creator, else their explicit collection-member role, else — when the
  // collection's own workspace_access is `member` — their workspace SEAT role,
  // else null (no access). Shared by the collections routes and the artifact
  // listing (collection scoping).
  const collectionActor = async (c: Context, col: CollectionRecord): Promise<Actor> => {
    const locked = !!col.password_hash
    const unlocked = !!openCollectionLinkRole(c, col)
    const p = await resolvePrincipal(c)
    if (p.kind === "token") return { kind: "token" }
    if (p.kind === "anonymous") return { kind: "anon", locked, unlocked }
    if (p.kind === "agent") {
      const ownerId = p.onBehalfOf
      const workspaceActive = p.agent.org_id === col.org_id
      const memberRole = ownerId
        ? ((await meta.getCollectionMember(col.id, ownerId))?.role ?? null)
        : null
      const portableMemberRole = workspaceActive || memberRole !== "owner" ? memberRole : null
      const ownerStanding = ownerId
        ? maxRole(
            workspaceActive && col.created_by === ownerId ? "owner" : null,
            portableMemberRole,
            workspaceActive && col.workspace_access === "member"
              ? ((await meta.getMembership(col.org_id, ownerId))?.role ?? null)
              : null,
          )
        : null
      return {
        kind: "user",
        userId: p.agent.id,
        artifactRole: ownerStanding ? capRole(ownerStanding, p.agent.role) : null,
        orgRole: p.agent.org_id === col.org_id ? p.agent.role : null,
        locked,
        unlocked,
      }
    }
    const me = p.user
    const workspaceActive = (await activeWorkspace(c)) === col.org_id
    // A collection lives in a workspace, so — same share experience as an
    // artifact's workspace_access — its members reach it at their SEAT role when
    // it's workspace-open; an invite-only collection (workspace_access=none)
    // grants nothing from mere membership, matching Invited. An explicit
    // collection share (which can cross workspaces) folds in alongside either
    // way, higher wins. This is the role on the COLLECTION itself; a workspace-open
    // collection propagates that same seat role to every artifact inside it —
    // collectionRolesForArtifact mirrors this exact rule (explicit membership OR a
    // seat on a workspace-open collection), so visibility of the collection and of
    // its contents stay in lockstep (no phantom-empty collections).
    const memberRole = (await meta.getCollectionMember(col.id, me.id))?.role ?? null
    const explicit = workspaceActive || memberRole !== "owner" ? memberRole : null
    const standing = maxRole(workspaceActive && col.created_by === me.id ? "owner" : null, explicit)
    const seat =
      workspaceActive && col.workspace_access === "member"
        ? ((await meta.getMembership(col.org_id, me.id))?.role ?? null)
        : null
    return { kind: "user", userId: me.id, artifactRole: standing, orgRole: seat, locked, unlocked }
  }
  const collectionRole = async (c: Context, col: CollectionRecord): Promise<Role | null> =>
    effectiveRole(await collectionActor(c, col), col.workspace_access, col.link_role)
  const collectionStandingRole = async (
    c: Context,
    col: CollectionRecord,
  ): Promise<Role | null> => {
    const actor = await collectionActor(c, col)
    return effectiveRole({ ...actor, unlocked: false }, col.workspace_access, "none")
  }

  // ---- Route guard helpers: the return-or-Response idiom (mirrors `limited`), so a
  // route opens with `const x = await require*(c); if (x instanceof Response) return x`.
  // Resolve the :shortId artifact and gate it. Default: 404 for BOTH missing and
  // unauthorized, so a gated artifact you can't read is indistinguishable from one
  // that isn't there (existence never leaks) — right for `read`. Pass
  // `{ split: true }` for actions where the caller SHOULD learn "it exists but you
  // can't <action> it" (comment/publish/share/manage) — 404 missing, 403
  // unauthorized. Returns the artifact, or the Response to return.
  const requireArtifact = async (
    c: Context,
    action: Action,
    opts?: { split?: boolean },
  ): Promise<ArtifactRecord | Response> => {
    const shortId = c.req.param("shortId")
    const a = shortId ? await meta.getByShortId(shortId) : null
    if (!a) return fail(c, 404, "not found")
    if (!(await authorize(c, action, a))) {
      return opts?.split ? fail(c, 403, "forbidden") : fail(c, 404, "not found")
    }
    return a
  }
  // The caller's active-workspace org id, or the 403 to return — collapses the
  // `workspaceCan` + `activeWorkspace` pair every workspace-scoped route opens with.
  const requireWorkspace = async (c: Context, action: Action): Promise<string | Response> => {
    if (!(await workspaceCan(c, action))) return fail(c, 403, "forbidden")
    return activeWorkspace(c)
  }
  // The signed-in user, or the 401 to return — the guard every authed route opens with.
  const requireUser = async (c: Context): Promise<SessionUser | Response> =>
    (await currentUser(c)) ?? fail(c, 401, "unauthenticated")
  // A decision that Derive presents as HUMAN must come from the direct signed-in
  // principal. An agent's on-behalf relationship is valid attribution for authored
  // work, but it is not consent to sign off; the static operator token is not a
  // person either. Resolve the Principal rather than calling currentUser so a
  // request carrying both an agent bearer and a session cookie remains an agent
  // request (bearer precedence) and cannot smuggle the cookie through this gate.
  const requireDirectHuman = async (
    c: Context,
  ): Promise<{ id: string; name: string } | Response> => {
    const p = await resolvePrincipal(c)
    if (p.kind !== "human") return fail(c, 403, "a signed-in human must make this decision")
    return {
      id: p.user.id,
      name: p.user.name ?? p.user.username ?? p.user.email,
    }
  }
  // The static CI/agent token (DERIVE_TOKEN) presented as this request's bearer.
  const isToken = (c: Context): boolean => !!deps.token && safeEqual(bearer(c), deps.token)
  // Is the caller a member of this workspace? The static token counts as a member of
  // every workspace. Callers still decide whether a non-member gets 403 or empty results.
  const isMember = async (c: Context, orgId: string): Promise<boolean> => {
    if (isToken(c)) return true
    const me = await currentUser(c)
    return !!me && !!(await meta.getMembership(orgId, me.id))
  }

  // May this user ask this context? A context is a workspace-scoped data-access
  // grant, NOT a document — so this deliberately does not consult the manifest's
  // artifact access (which can carry a world link or public listing). The hard
  // floor is workspace membership: a non-member — however they hold a link — can
  // never ask. Within the workspace, `workspace` policy admits every member;
  // `invited` admits the creator and the asker roster. Askers are people (a
  // session is on-behalf-of a human): the request-keyed wrapper below requires a
  // signed-in user, and the MCP ask tools pass their connection's on-behalf
  // human — a bare agent/static token never asks as itself.
  const canUserAskContext = async (userId: string, x: ContextRecord): Promise<boolean> => {
    if (!(await meta.getMembership(x.org_id, userId))) return false
    if (x.created_by === userId) return true
    if (x.ask_policy === "workspace") return true
    return !!(await meta.getContextAsker(x.id, userId))
  }
  const canAskContext = async (c: Context, x: ContextRecord): Promise<boolean> => {
    const me = await currentUser(c)
    return !!me && (await canUserAskContext(me.id, x))
  }

  return {
    deps,
    meta,
    blobs,
    callModel: deps.callModel,
    models: configuredModels,
    modelGateway: deps.modelGateway,
    /**
     * THE CATALOG A TURN CHOOSES FROM: the configured one, widened by the operator's live
     * library. Every path that answers a turn or offers a choice goes through here rather than
     * reading `models` — a model an operator added is otherwise invisible to the surface that
     * would have used it, which is the whole feature not working.
     *
     * Not memoized per request on purpose. It is a single settings read, the same row the chat
     * lane already reads for the pinned model, and the one property it must have is that the
     * NEXT turn sees the change.
     */
    modelsFor,
    chatAllowlist: deps.chatAllowlist,
    search: deps.search,
    summarize: deps.summarize,
    bus,
    presence,
    backplane,
    analyticsOn,
    versionWindowMs,
    allowOrigins,
    defaultRole,
    publishLimiter,
    commentLimiter,
    unlockLimiter,
    inviteLimiter,
    askLimiter,
    notify,
    notifyRender,
    background,
    attendedTurnBudgetMs: deps.attendedTurnBudgetMs,
    /**
     * Answer an @derive mention in a comment thread — the comment lane's arrival, built once
     * here because it needs the model catalog, the store and the publish path in one hand.
     *
     * Passed INTO commentCreatedAction by every caller that creates a comment, so a mention
     * typed in the web app, over MCP, or in a synced Slack thread all reach the same turn.
     * Undefined when this deploy has no model, which is the honest "nothing answers" state.
     */
    answerDeriveMention: configuredModels
      ? answerDeriveMention({
          meta,
          blobs,
          bus,
          baseUrl: deps.baseUrl,
          models: modelsFor,
          notify,
          chatAllowlist: deps.chatAllowlist,
        })
      : undefined,
    currentUser,
    agentFor,
    // The run id a dkrun_ capability bearer is pinned to (null for every other principal).
    // Run endpoints use it to constrain claim/tool/finish to exactly that run.
    agentRunScope: (c: Context): string | null => runScopeCache.get(c) ?? null,
    /** The session id a dksess_ capability bearer is pinned to (null for every other
     *  principal) — the ask lane's twin of agentRunScope. */
    agentSessionScope: (c: Context): string | null => sessionScopeCache.get(c) ?? null,
    /** Is this request authenticated by a MINTED api token (dkapi_)? The mint refuses
     *  to run off one: a token minting its successor with a fresh TTL would renew
     *  itself indefinitely and quietly defeat the "expires in minutes" property that
     *  makes a leaked one a bounded liability. Mint from the grant, not from a mint. */
    isMintedApiToken: (c: Context): boolean => mintedApiCache.get(c) ?? false,
    resolvePrincipal,
    actingUser,
    actingHuman,
    privateOwnerId,
    managementPrincipal,
    oauthGrant,
    limited,
    overStorage,
    billingState,
    billingBlocked,
    billingGate,
    seatGrantGate,
    blockCopy,
    effectiveWhiteLabel,
    ensureMembership,
    /** `meta.getMembership`, memoized for this request. Routes that need a caller's role
     *  in a workspace should call THIS, not the store directly — the same row is usually
     *  already resolved by `activeWorkspace`/`workspaceRole`, and a direct call re-pays a
     *  full ~80ms round trip for it. */
    membershipOf: cachedMembership,
    /** `meta.listWorkspaces`, memoized for this request — see cachedWorkspaces. */
    workspacesOf: cachedWorkspaces,
    activeWorkspace,
    setWsCookie,
    anonViewerId,
    guestViewerId,
    actorFor,
    authorize,
    authorizeStanding,
    authorizeUserStanding,
    anonLocked,
    isPrincipal,
    isSuperAdmin,
    workspaceRole,
    workspaceCan,
    collectionRole,
    collectionStandingRole,
    sourceText,
    requireArtifact,
    requireWorkspace,
    requireUser,
    requireDirectHuman,
    isToken,
    isMember,
    canAskContext,
    canUserAskContext,
  }
}
