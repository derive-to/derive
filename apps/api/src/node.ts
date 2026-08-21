import { mkdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { BlobStore, MetaStore, SearchIndex } from "@derive/core"
import { PgMetaStore } from "@derive/db/pg"
import { PgVectorStore } from "@derive/db/pgvector"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { s3FromUrl } from "@derive/storage/s3"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { createApp } from "./app"
import { type AuthDb, makeAuth, migrateAuth, OAUTH_ANON_CLIENT_TTL_MS } from "./auth-config"
import { createInProcessBackplane } from "./bus"
import { loadConfig, resolveAuthSecret, resolveDefaultOrg } from "./config"
import { configWarnings } from "./config-manifest"
import { restEmbedder } from "./embedder"
import { loadLocalEmbedder } from "./embedder-local"
import { purgeUserDataAndSyncSeats, workspacesBlockingDeletion } from "./lib/account"
import { makeBillingDriver } from "./lib/billing"
import { customDomainsFromEnv } from "./lib/cloudflare-saas"
import { nodeSandbox } from "./lib/code-sandbox-node"
import { answerDeriveMention } from "./lib/comment-turn"
import { dispatchPass, dispatchRunNow } from "./lib/dispatch"
import { sweepExpiredDrafts } from "./lib/drafts"
import { buildAuthEmail, emailDeliverySender, logEmailSender, resendEmailSender } from "./lib/email"
import { workspaceIdsFromEnv } from "./lib/env"
import { makeGithubCommentSender } from "./lib/github-comments"
import { catalogFromGateway, type GatewayConfig } from "./lib/model-catalog"
import { getInstanceSlot, modelSource, readLibrary } from "./lib/model-library"
import { mountWeb } from "./lib/serve-web"
import { signupPolicy } from "./lib/signup-policy"
import { makeSlackIngestSender, makeSlackSender } from "./lib/slack-comments"
import { makeSlackDmSender } from "./lib/slack-dm"
import { loopSubstrate } from "./lib/substrate-loop"
import { nodeSubstrate } from "./lib/substrate-node"
import { providerSubstrate } from "./lib/substrate-provider"
import { makeShutdown } from "./lifecycle"
import { log } from "./log"
import { createNodeSyncRunner } from "./node-sync"
import { playwrightRenderer } from "./preview-node"
import { startPreviewWorker } from "./previews"
import { PgvectorSearchIndex } from "./search-pgvector"
import { type ChannelSenders, enqueueChannelDelivery, startWebhookWorker } from "./webhooks"
import { nodeDnsGuard } from "./webhooks-node"

// Best-effort load a local .env (repo root, then cwd) before reading config, so
// wiring up Postgres / OAuth / S3 locally is just editing .env instead of exporting
// vars each shell. Real deployments inject env vars directly, so a missing file is
// expected — hence the swallowed throw.
// Snapshot BEFORE the .env load: the override for the remote-database gate
// below must come from the actual shell, not from the same .env file whose
// contents the gate exists to distrust.
const allowRemoteDbFromShell = process.env.DERIVE_ALLOW_REMOTE_DB === "1"
for (const envPath of [join(import.meta.dirname, "../../../.env"), resolve(".env")]) {
  try {
    process.loadEnvFile(envPath)
    break
  } catch {
    /* no .env at this path — carry on */
  }
}

const cfg = loadConfig()

// A dev server must never point at a remote database silently. The .env load
// above makes that a one-line accident: a production DATABASE_URL left in the
// repo root (say, from debugging an outage) turns every `pnpm dev` — and the
// e2e harness — into a writer against prod. It happened. Matched on the whole `dev*`
// family, not `dev` alone: a sibling script (`dev:prod-db`, and whatever comes next)
// arrives with its own lifecycle event, and keying on one exact string would let any
// of them walk straight past this. Deployments launch the entry directly with no
// lifecycle event, so they are unaffected.
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"])
const dbHost = (() => {
  try {
    // Lowercased by hand: postgres:// is a non-special scheme, so the WHATWG
    // parser keeps the host's original case.
    return cfg.databaseUrl ? new URL(cfg.databaseUrl).hostname.toLowerCase() : null
  } catch {
    return null // unparseable URL: treat as remote — fail toward the gate
  }
})()
const localDb = !!dbHost && (LOCAL_DB_HOSTS.has(dbHost) || dbHost.endsWith(".localhost"))
const remoteDb = !!cfg.databaseUrl && !localDb
if (remoteDb && (process.env.npm_lifecycle_event ?? "").startsWith("dev")) {
  if (!allowRemoteDbFromShell) {
    log.error(
      "refusing to start: dev mode with a remote DATABASE_URL (set DERIVE_ALLOW_REMOTE_DB=1 to override)",
      { host: dbHost ?? "unparseable" },
    )
    process.exit(1)
  }
  log.warn("dev mode is using a REMOTE database (DERIVE_ALLOW_REMOTE_DB=1)")
}

// Postgres + object storage is genuinely stateless. Do not manufacture a /data
// dependency in that topology merely because the Lite topology needs one.
if (!cfg.databaseUrl || !cfg.objectStoreUrl)
  mkdirSync(join(cfg.dataDir, "blobs"), { recursive: true })

// Metadata + auth share one datastore: Postgres when DATABASE_URL is set (the
// stateless multi-instance topology), else embedded SQLite (zero-config).
let meta: MetaStore
let authDb: AuthDb
// The dense/semantic search arm — pgvector in the same Postgres, embeddings from a local ONNX model
// or Workers AI REST (DERIVE_EMBED_PROVIDER). Only on the Postgres datastore (pgvector lives there);
// undefined ⇒ searchWorkspace stays lexical-only.
let search: SearchIndex | undefined
// Closes the metadata store + the Better Auth datastore (separate handles onto
// the same backend) for graceful shutdown.
let closeStores: () => Promise<void>
if (cfg.databaseUrl) {
  // A pool 'error' (DB restart / network blip / Neon scale-to-zero) without a
  // listener becomes an unhandled exception that crashes the process — log it.
  const pgMeta = await PgMetaStore.create(cfg.databaseUrl, (e) =>
    log.error("pg meta pool error", { error: e.message }),
  )
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  pool.on("error", (e) => log.error("pg auth pool error", { error: e.message }))
  meta = pgMeta
  authDb = pool
  // Dense arm on a dedicated small pool (its lifecycle is independent of auth). ensureSchema
  // creates the extension + vector table + HNSW index once, at boot, before serving. This is an
  // OPTIONAL feature: if it can't be set up (e.g. the Postgres role can't `CREATE EXTENSION
  // vector`), we log and fall back to lexical-only — never crash a running instance over a search
  // add-on, matching the "warn, don't crash" contract the rest of this entrypoint follows.
  let closeVector = async () => {}
  if (cfg.denseSearch) {
    const dense = cfg.denseSearch
    try {
      // `local` loads an in-process ONNX model (bge-small, no creds; downloads on first boot then
      // cached); `workersai` calls Cloudflare Workers AI over REST. The store's dimension follows
      // whichever embedder — they must not be mixed on one DB (the dimension guard enforces it).
      // The local load is raced against a timeout so a STALLED model download (vs a clean failure,
      // which the try/catch already handles) can't hang boot forever — it degrades to lexical.
      const embedder =
        dense.provider === "local"
          ? await Promise.race([
              loadLocalEmbedder(),
              new Promise<never>((_, reject) => {
                setTimeout(
                  () =>
                    reject(new Error("local embedder load timed out (model download stalled?)")),
                  120_000,
                ).unref()
              }),
            ])
          : restEmbedder(dense.accountId, dense.apiToken)
      const vectorPool = new Pool({ connectionString: cfg.databaseUrl, max: 4 })
      // Register cleanup BEFORE the throwable ensureSchema so a failure can't orphan the pool.
      closeVector = () => vectorPool.end()
      vectorPool.on("error", (e) => log.error("pg vector pool error", { error: e.message }))
      // Widen HNSW candidate breadth to ≥ topK (pgvector's default ef_search=40 would cap our
      // topK-50 over-fetch). Set once per pooled connection; harmless before the extension loads
      // (accepted as a placeholder, honored on first vector query).
      vectorPool.on("connect", (c) => {
        c.query("SET hnsw.ef_search = 100").catch((e) =>
          log.error("failed to set hnsw.ef_search", { error: e.message }),
        )
      })
      const store = new PgVectorStore(vectorPool, embedder.dimensions)
      await store.ensureSchema()
      search = new PgvectorSearchIndex(embedder, store)
      log.info("dense search enabled", {
        store: "pgvector",
        provider: dense.provider,
        embedder: embedder.model,
        dimensions: embedder.dimensions,
      })
    } catch (e) {
      log.error(
        "dense search setup failed — falling back to lexical-only. Check the Postgres role can CREATE EXTENSION vector (or pre-create it), and the embedder (local model download, or Workers AI credentials).",
        { error: e instanceof Error ? e.message : String(e) },
      )
      await closeVector()
      closeVector = async () => {} // reset so closeStores doesn't end the pool twice
      search = undefined
    }
  }
  closeStores = async () => {
    await pgMeta.close()
    await pool.end()
    await closeVector()
  }
} else {
  const db = new Database(join(cfg.dataDir, "derive.db"))
  // Better Auth opens its own connection to the same derive.db. Match the store's
  // WAL + busy_timeout so concurrent auth writes (e.g. bursts of signups) wait
  // for the lock instead of failing with SQLITE_BUSY.
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")
  const sqliteMeta = new SqliteMetaStore(join(cfg.dataDir, "derive.db"))
  meta = sqliteMeta
  authDb = db
  if (cfg.denseSearch)
    log.warn(
      "dense search embedder is configured but the datastore is embedded SQLite; pgvector needs Postgres — set DATABASE_URL to enable semantic search. Staying lexical-only.",
    )
  closeStores = async () => {
    sqliteMeta.close()
    db.close()
  }
}

const authSecret = resolveAuthSecret(cfg.dataDir)
// A real transactional email transport (Resend) is configured — otherwise the safe
// log sender records only recipient + subject (never capability URLs), and the SPA
// hides self-serve mail flows (see `emailEnabled` in createApp deps).
const emailEnabled = !!(cfg.resendApiKey && cfg.emailFrom)
// Hoisted above makeAuth (rather than built inline down at createApp's `billing:` dep,
// where it lived before) so the account-deletion hook below and the billing routes
// share the exact same driver instance instead of constructing two.
const billing = makeBillingDriver(cfg.stripeSecretKey, cfg.stripeWebhookSecret)
const auth = makeAuth(authDb, cfg.baseUrl, authSecret, {
  signupAllowed: signupPolicy(cfg.signupMode, authSecret, meta),
  usernameTaken: (u) => meta.getUserByUsername(u).then(Boolean),
  // Render + enqueue transactional auth emails (reset / verify / change-email) onto the
  // same retrying outbox as notifications; the configured sender transports them.
  sendAuthEmail: (kind, input) =>
    enqueueChannelDelivery(meta, "email", `auth.${kind}`, buildAuthEmail(kind, input)),
  // Account deletion: block if they'd orphan workspace or resource ownership, else purge.
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
await migrateAuth(auth)

// Better Auth adds the `username` column but can't make it UNIQUE on an existing
// table: its migration would emit `ALTER TABLE user ADD COLUMN username TEXT UNIQUE`,
// which SQLite rejects ("Cannot add a UNIQUE column"). Create the unique index here
// instead — idempotent, both dialects, and NULL-tolerant so unclaimed handles don't
// collide. This is the hard backstop behind the usernameTaken assignment hook.
if (cfg.databaseUrl) {
  await (authDb as Pool).query(
    `CREATE UNIQUE INDEX IF NOT EXISTS user_username ON "user" (username)`,
  )
} else {
  ;(authDb as Database.Database)
    .prepare(`CREATE UNIQUE INDEX IF NOT EXISTS user_username ON "user" (username)`)
    .run()
}

// Backfill author_id on artifacts that predate the column: where a GitHub-synced
// artifact's commit author (author_gh_id) maps to a Derive account, attribute it to that
// user so their synced work surfaces on their profile + feed by author_id directly.
// Idempotent — only fills nulls that have a known GitHub→user mapping; a no-op once done.
// Runs after the auth tables exist. Hand-published pre-feature work without a GitHub
// identity has no recoverable author and stays null (it re-stamps on its next publish).
void meta.backfillAuthorIds().then((n) => {
  if (n > 0) log.info(`backfilled author_id on ${n} artifact(s)`)
})

const defaultOrg = resolveDefaultOrg(cfg.dataDir)

// One-time rekey of the pre-multi-workspace "local" sentinel onto the real
// default org id. Idempotent (no rows remain on 'local' afterward) and a no-op
// for fresh installs and hosted Postgres that never used 'local'.
if (defaultOrg !== "local") {
  const orgTables = ["membership", "artifact", "collection", "agent"]
  if (cfg.databaseUrl) {
    const pool = authDb as Pool
    for (const t of orgTables)
      await pool.query(`UPDATE "${t}" SET org_id = $1 WHERE org_id = 'local'`, [defaultOrg])
    await pool.query(`UPDATE workspace SET id = $1 WHERE id = 'local'`, [defaultOrg])
  } else {
    const db = authDb as Database.Database
    for (const t of orgTables)
      db.prepare(`UPDATE ${t} SET org_id = ? WHERE org_id = 'local'`).run(defaultOrg)
    db.prepare(`UPDATE workspace SET id = ? WHERE id = 'local'`).run(defaultOrg)
  }
}

// (The one-time pre-v2 → v2 access backfill used to run here. Retired with the
// v1 `visibility`/`general_role` columns — a database upgrading straight from a
// pre-v2 build runs deploy/drop-v1-access.sql, which folds the old values into
// the access fields before dropping them.)

// Blobs: S3/R2 when OBJECT_STORE_URL is set, else local disk (zero-config).
const blobs: BlobStore = cfg.objectStoreUrl
  ? s3FromUrl(cfg.objectStoreUrl)
  : new FsBlobStore(join(cfg.dataDir, "blobs"))

// The SPA shell, read once: passed to createApp (so /artifacts/:ref can inject unfurl
// meta) and to mountWeb (the client-router fallback). Only when serving the web.
const shellHtml = cfg.serveWeb ? readFileSync(cfg.webShell, "utf8") : undefined

// The marketing pages, read once from the build's site/ directory like the shell
// above. Only the hosted build assembles them (apps/web/scripts/build-hosted.mjs),
// so a self-host resolves null here and the routes fall back to the shell — the
// front door can never 404, and it is never derive.to's brochure.
const readSitePage = (name: string): string | null => {
  try {
    return readFileSync(join(cfg.webDir, "site", name), "utf8")
  } catch {
    return null
  }
}
const notFoundHtml = cfg.serveWeb ? readSitePage("../404.html") : null
const marketingHome = cfg.serveWeb ? readSitePage("index.html") : null
const marketingPricing = cfg.serveWeb ? readSitePage("pricing.html") : null
const marketingPrivacy = cfg.serveWeb ? readSitePage("privacy.html") : null
const marketingExamples = cfg.serveWeb ? readSitePage("examples.html") : null
const marketing =
  marketingHome || marketingPricing || marketingPrivacy || marketingExamples
    ? {
        home: async () => marketingHome,
        pricing: async () => marketingPricing,
        privacy: async () => marketingPrivacy,
        examples: async () => marketingExamples,
      }
    : undefined

// The webhook outbox drainer: an interval delivers queued events with retries +
// backoff, and `poke` (wired into the app below) drains on demand so a fresh event
// goes out immediately. `nodeDnsGuard` re-resolves each target at delivery time and
// refuses private/internal addresses — the SSRF defense that matters most on an
// internal corporate network, where a webhook URL could point at a private service.
// First-party channel senders for the Node tier. Email uses Resend (over fetch) when
// RESEND_API_KEY is set, else the log sender (visible in dev, no transport needed).
// The edge tier wires the Cloudflare Email Service binding instead (see webhook-do.ts).
// The realtime relay, created here so the inbound Slack-ingest sender (which runs on the
// worker, outside a request) can publish comment.created to live viewers over the same
// in-process bus the request handlers use. Passed into createApp below so both share it.
const backplane = createInProcessBackplane()
/** An operator-configured OpenAI-compatible endpoint, or null. ALL THREE vars or none: a base URL
 *  with no key would 401 every run, and a key with no model id would send an empty model — both
 *  are silent-at-boot, loud-at-3am failures, so an incomplete set is treated as unset and warned
 *  about once here. */
const modelGateway = (): GatewayConfig | null => {
  const baseUrl = process.env.DERIVE_MODEL_BASE_URL
  const apiKey = process.env.DERIVE_MODEL_API_KEY
  const model = process.env.DERIVE_MODEL_NAME
  // DERIVE_MODEL_NAMES is optional and additive: more model ids the SAME gateway serves, which
  // is how every one of these hosts works. Unset ⇒ a one-model catalog, exactly as before.
  if (baseUrl && apiKey && model)
    return {
      baseUrl,
      apiKey,
      model,
      alsoModels: process.env.DERIVE_MODEL_NAMES,
      providers: process.env.DERIVE_MODEL_PROVIDERS,
    }
  if (baseUrl || apiKey || model)
    log.warn("model gateway ignored: set DERIVE_MODEL_BASE_URL, _API_KEY and _NAME together", {
      baseUrl: !!baseUrl,
      apiKey: !!apiKey,
      model: !!model,
    })
  return null
}

// The model catalog, built before the channel senders because the Slack ingest sender needs
// it (an @Derive mention typed in a thread runs the same turn the web app's mention does).
const gatewayModels = catalogFromGateway(modelGateway())
// …and the LIVE view of it: the configured catalog widened, per turn, by the operator's model
// library. This sender is built once at boot and outlives every settings change, so it takes
// the source rather than the catalog — see lib/model-library.ts.
const gatewayModelSource = modelSource(gatewayModels, modelGateway(), () => readLibrary(meta))

const channelSenders: ChannelSenders = {
  email: emailDeliverySender(
    cfg.resendApiKey && cfg.emailFrom
      ? resendEmailSender(cfg.resendApiKey, cfg.emailFrom)
      : logEmailSender(),
  ),
  // GitHub PR comment write-back mints an installation token per delivery from the
  // stored App (encrypted with the auth secret).
  github_review_comment: makeGithubCommentSender(meta, authSecret),
  github_issue_comment: makeGithubCommentSender(meta, authSecret),
  // Slack App posting (bot token decrypted with the auth secret per delivery): the
  // comment thread mirror and per-user DMs (mentions, review requests, shares).
  slack_app: makeSlackSender(meta, authSecret),
  slack_dm: makeSlackDmSender(meta, authSecret),
  // Inbound: a Slack thread reply the events endpoint deferred — resolve the author and
  // write the Derive comment here, off the ack path, publishing to the shared bus.
  // The 4th argument is @Derive typed in a Slack thread: the same turn a mention in the web
  // app runs, using the same model catalog. Absent on a deploy with no model.
  slack_ingest: makeSlackIngestSender(
    meta,
    authSecret,
    backplane,
    gatewayModels
      ? answerDeriveMention({
          meta,
          blobs,
          bus: backplane,
          baseUrl: cfg.baseUrl,
          models: gatewayModelSource,
          notify: async () => {},
          chatAllowlist: (process.env.DERIVE_CHAT_ALLOWLIST ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        })
      : undefined,
  ),
}
// Off only when DERIVE_BACKGROUND_WORKERS=0 — a local process sharing a remote database
// must not drain that database's delivery outbox out from under the real deployment.
const webhookWorker = cfg.backgroundWorkers
  ? startWebhookWorker(meta, nodeDnsGuard, channelSenders)
  : undefined

// Preview render worker: an in-process interval + poke that renders screenshot jobs via
// Playwright Chromium. Only started when DERIVE_PREVIEWS=true; when off the render queue
// is never enqueued (renderPreviews stays false below) and no worker runs.
const previewWorker = cfg.previews
  ? startPreviewWorker({
      meta,
      blobs,
      renderer: playwrightRenderer(),
      baseUrl: cfg.baseUrl,
      sandboxOrigin: cfg.sandboxOrigin,
      secret: authSecret,
    })
  : undefined

// GitHub-sync runner: drives a triggered sync to completion in-process (detached from
// the request) so it survives the user navigating away — the self-host counterpart to
// the edge `RepoSyncRunner` DO. Resumed below on boot + a short interval.
const syncRunner = createNodeSyncRunner(meta, blobs, authSecret)

// EXPERIMENTAL hosted runs (DERIVE_HOSTED_RUNS, default off): this API process becomes the
// executor host — it materializes due schedules, reclaims runs whose executor died, and starts
// each due run as a `derive runner run` child process on this box, so an automation updates its
// artifact with no separate machine and no polling runner. Off by default because it spawns
// processes and spends the run initiator's model plan; a deployment opts in deliberately. When

// off, runs stay queued for a polling `derive runner` exactly as before.
const hostedDispatch = cfg.hostedRuns
  ? {
      meta,
      // WHICH SUBSTRATE. `DERIVE_LOOP_RUNS=1` executes runs in this process — a model and fetch,
      // no child process and no container, which is all "read something, write an artifact"
      // actually needs. Anything wanting a shell, a filesystem or git still belongs on the child
      // process, so the CLI runner stays the default and the flag is the opt-in.
      //
      // The loop substrate is the SAME file the Worker entry would use: it is an HTTP client of
      // this API, so there is no platform branch and nothing to keep in step between the two.
      //
      // ONE substrate for both lanes. Sessions used to be pinned to the child process because
      // the loop served runs only; it now branches on the work token and claims an ask through
      // `/v1/agent/sessions/claim`, so the split is gone.
      substrate:
        process.env.DERIVE_LOOP_RUNS === "1"
          ? providerSubstrate({
              fallback: loopSubstrate({
                // DERIVE_LOOP_MODEL, not DERIVE_MODEL_NAME: this field is the ANTHROPIC model id
                // used on the per-run resolved-credential path, while DERIVE_MODEL_NAME names the
                // model on the GATEWAY below. Passing the gateway's id here pointed a Fireworks
                // path at api.anthropic.com and 404'd every run that resolved a real plan.
                model: process.env.DERIVE_LOOP_MODEL,
                gateway: modelGateway() ?? undefined,
                // The operator's live pin for this lane, read per run. `meta` is module-scope and
                // always valid on this tier, so there is nothing to capture at dispatch time.
                gatewayModel: async () => (await getInstanceSlot(meta, "automation")) ?? undefined,
              }),
              providers: { codex: nodeSubstrate({ bin: cfg.runnerBin }) },
            })
          : nodeSubstrate({ bin: cfg.runnerBin }),
      server: cfg.baseUrl,
      secret: authSecret,
      // A generic gateway pays only when the selected unattended substrate can actually use it.
      // The CLI child cannot, and must resolve its own Claude/Codex plan through the payer chain.
      operatorPays: process.env.DERIVE_LOOP_RUNS === "1" && modelGateway() !== null,
      // Self-host stays unrestricted when unset. Setting the variable (including explicitly
      // blank) gives an operator the same precise rollout/kill boundary as the shared host.
      ...(process.env.DERIVE_HOSTED_RUNS_ALLOWLIST === undefined
        ? {}
        : { hostedOrgIds: workspaceIdsFromEnv(process.env.DERIVE_HOSTED_RUNS_ALLOWLIST) }),
    }
  : null

const gateway = modelGateway()

const app = createApp({
  meta,
  // Self-host: whatever the image was built from. Docker builds can pass it; a source run
  // reports "dev". Same contract as the edge — /healthz answers "what is running".
  buildId: process.env.DERIVE_BUILD_SHA,
  // The ATTENDED path only. Unattended runs still resolve their own credential per run through
  // the payer chain — this key never becomes the answer to "who pays" for queued work.
  //
  // Both come from ONE construction: `callModel` is the catalog's default entry, so "the model"
  // means the same thing to a lane that picks one and a lane that does not.
  callModel: gatewayModels?.resolve(null)?.callModel,
  automationOperatorPays:
    cfg.hostedRuns && process.env.DERIVE_LOOP_RUNS === "1" && gateway !== null,
  models: gatewayModels ?? undefined,
  // The gateway that catalog was built from, so the operator's model library can reach an id
  // the environment never named — same endpoint, same key, no new secret. Without it the
  // library can still relabel and pin a lane, but not ADD. See lib/model-library.ts.
  modelGateway: gateway ?? undefined,
  chatAllowlist: (process.env.DERIVE_CHAT_ALLOWLIST ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  blobs,
  // Share the realtime relay with the webhook worker so a deferred Slack reply publishes
  // comment.created to the same in-process subscribers a request would.
  backplane,
  // Dense/semantic arm (pgvector) when configured on Postgres; undefined ⇒ lexical-only.
  search,
  baseUrl: cfg.baseUrl,
  shell: shellHtml,
  // The marketing front door (`/` for signed-out visitors + `/pricing` + `/privacy`);
  // unset only when the web build ships no site/ pages, leaving the SPA all paths.
  marketing,
  token: cfg.token,
  // Encrypt stored third-party secrets (GitHub PATs) at rest with the auth secret.
  encryptionKey: authSecret,
  allowEchoStub:
    process.env.DERIVE_LOCAL_BROKER === "1" || process.env.DERIVE_LOCAL_BROKER === "true",
  // The isolate derive_code runs in. Node-only by construction: worker_threads does not exist on
  // Cloudflare, so the edge entry passes nothing and the tool does not register there.
  codeSandbox: nodeSandbox(),
  superAdmins: cfg.superAdmins,
  slack: cfg.slack,
  auth,
  webOrigins: cfg.webOrigins,
  analytics: cfg.analytics,
  // Gate the mail-dependent capabilities (password reset, email verification) so the SPA
  // surfaces them only when a real transport can actually deliver.
  emailEnabled,
  rateLimit: cfg.rateLimit,
  serveWeb: cfg.serveWeb,
  // Fly gives HTTP/2 but doesn't compress; gzip here. (The Worker edge does its
  // own compression, so worker.ts leaves this off.)
  compress: true,
  defaultOrgId: defaultOrg,
  // Origin isolation: serve artifact bytes from a separate registrable domain
  // pointed at this same container. Keeps user HTML off the app's cookie origin.
  sandboxOrigin: cfg.sandboxOrigin,
  crossSite: cfg.crossSite,
  // Vanity subdomains (domain mode): when set, name.<base> serves its artifact.
  subdomainBase: cfg.subdomainBase,
  // BYO custom domains via Cloudflare for SaaS, when CF_* env is configured.
  customDomains: customDomainsFromEnv(process.env),
  versionWindowMs: cfg.versionWindowMs,
  // Storage backstops: unset = unlimited (self-host stays open).
  maxArtifacts: cfg.maxArtifacts,
  maxBytes: cfg.maxBytes,
  billing,
  billingEnforceAt: cfg.billingEnforceAt,
  // Per-actor write rate limits (per minute); unset = built-in defaults.
  publishRate: cfg.publishRate,
  commentRate: cfg.commentRate,
  // Deliver freshly enqueued events immediately instead of on the next interval.
  // No worker (DERIVE_BACKGROUND_WORKERS=0) ⇒ nothing to poke; events still enqueue,
  // and the real deployment's worker delivers them.
  pokeWebhooks: webhookWorker?.poke,
  // Enqueue a render job on publish and drain on demand when previews are enabled.
  renderPreviews: cfg.previews,
  pokePreviews: previewWorker?.poke,
  // Run a triggered GitHub sync in the background so it survives a closed tab.
  startSync: syncRunner.start,
  // Start a just-created run immediately instead of at the next tick, so "Run now" and a fire
  // URL feel instant. Unset when hosted runs are off — the run then waits for a polling runner.
  pokeRun: hostedDispatch
    ? (runId: string) => void dispatchRunNow(hostedDispatch, runId).catch(() => undefined)
    : undefined,
})

// Serve the bundled SPA from this process (single-container self-host). The API
// routes above always win; the server-owned path set, the immutable-asset caching,
// and the index.html fallback live in mountWeb, shared as one contract with the
// edge Worker (wrangler.toml) and the dev proxy (serve-web.test asserts parity).
if (cfg.serveWeb && shellHtml !== undefined)
  mountWeb(app, {
    webRoot: relative(process.cwd(), cfg.webDir) || ".",
    shellHtml,
    notFoundHtml: notFoundHtml ?? undefined,
  })

// Analytics retention: views are a rolling window (default 365 days). A daily
// prune keeps the append-only view table bounded. 0 disables pruning entirely.
// Daily maintenance: prune the rolling view window (when retention is on) and reap
// abandoned anonymous OAuth clients (open-DCR rows never consented, holding no
// tokens, > OAUTH_ANON_CLIENT_TTL_MS old). The reaper runs regardless of view
// retention; the authorize-time self-heal in app.ts covers a client that slips
// through anyway.
let pruneTimer: ReturnType<typeof setInterval> | undefined
const maintain = async () => {
  if (cfg.retentionDays > 0)
    await meta
      .pruneViews(new Date(Date.now() - cfg.retentionDays * 86400_000).toISOString())
      .catch(() => 0)
  await meta
    .pruneStaleOAuthClients(new Date(Date.now() - OAUTH_ANON_CLIENT_TTL_MS).toISOString())
    .catch(() => 0)
}
if (cfg.backgroundWorkers) {
  // Note this fires on BOOT as well as on the interval, and it DELETES — which is why
  // it is gated rather than merely slowed for a process pointed at a remote database.
  void maintain()
  pruneTimer = setInterval(maintain, 24 * 3600_000)
  pruneTimer.unref?.()
}

// Expired anonymous drafts (the claim flow): swept hourly — the 24h maintenance
// cadence is too coarse for a 72h TTL. The serve path already 410s an expired
// draft, so this only reclaims rows; the mint route also sweeps opportunistically.
const draftSweepTimer = cfg.backgroundWorkers
  ? setInterval(() => void sweepExpiredDrafts(meta, search).catch(() => 0), 3600_000)
  : undefined
draftSweepTimer?.unref?.()

// Resume any GitHub sync left mid-flight: once on boot (a restart mid-sync) and on a
// short interval (a self-heal backstop, mirroring the edge cron). The persisted
// file-map makes resume idempotent, and the runner dedupes already-running loops, so
// this is safe to call repeatedly. unref'd so it never holds the process open.
let syncResumeTimer: ReturnType<typeof setInterval> | undefined
if (cfg.backgroundWorkers) {
  void syncRunner.resumeStalled()
  syncResumeTimer = setInterval(() => void syncRunner.resumeStalled(), 60_000)
  syncResumeTimer.unref?.()
}

// EXPERIMENTAL hosted runs (DERIVE_HOSTED_RUNS=true, default off): this API process becomes
// the executor host. A minutely tick materializes due schedules, reclaims runs whose executor
// died, and starts each due run as a `derive runner run` child process on this box — so an
// automation updates its artifact with no separate machine and no polling runner. Off by
// default because it spawns processes and spends the owner's model plan; a deployment opts in
// deliberately. When off, runs stay queued for a polling `derive runner` (unchanged behavior).
let hostedRunsTimer: ReturnType<typeof setInterval> | undefined
if (hostedDispatch) {
  const hostedTick = () => void dispatchPass(hostedDispatch).catch(() => undefined)
  hostedTick() // catch up on boot, like every other worker here
  hostedRunsTimer = setInterval(hostedTick, 60_000)
  hostedRunsTimer.unref?.()
  // Report the substrate ACTUALLY in use, not a hardcoded guess. This said "node-child" even
  // when DERIVE_LOOP_RUNS had swapped in the in-process loop, so the one line an operator reads
  // to answer "what is executing my runs" was wrong — and wrong in the direction that sends you
  // looking for a child process that was never spawned.
  log.info("hosted runs ENABLED (experimental)", {
    substrate: hostedDispatch.substrate.name,
    ...(hostedDispatch.substrate.name === "node-child" ? { bin: cfg.runnerBin } : {}),
  })
}

// One-time cleanup of pre-existing owner self-views (the route no longer records
// them). Pre-multi-workspace rows were rekeyed from "local" onto defaultOrg above,
// so the legacy owners live under defaultOrg now (not the "local" sentinel). Match
// their id, name and email so rows from before the id-based identity change are
// caught too.
void (async () => {
  try {
    const owners = (await meta.listMemberships(defaultOrg)).filter((m) => m.role === "owner")
    if (owners.length === 0) return
    const users = await meta.getUsers(owners.map((m) => m.user_id))
    const viewers = [
      ...new Set(users.flatMap((u) => [u.id, u.name, u.email].filter((v): v is string => !!v))),
    ]
    const removed = await meta.pruneViewsByViewers(viewers)
    if (removed > 0) log.info(`analytics: removed ${removed} owner self-view(s)`)
  } catch {
    /* best-effort; never blocks boot */
  }
})()

// Loud warning for the footgun: a cross-site / public-looking deployment that
// serves untrusted artifact HTML on its own origin (no separate sandbox host).
// Single-origin self-host is a supported mode (the iframe sandbox is the wall);
// a cross-site setup without isolation is not.
if (!cfg.sandboxOrigin && (cfg.crossSite || cfg.webOrigins.length)) {
  log.warn(
    "DERIVE_SANDBOX_URL is unset on a cross-site deployment. Artifact HTML will be served from the app origin; set DERIVE_SANDBOX_URL to a separate domain to isolate untrusted content from session cookies.",
  )
}

// Half-configured optional features (an OAuth id without its secret, an email key without
// a from-address) leave the feature silently OFF. Warn loudly — but never crash: an
// operator shouldn't lose a running instance to a stray env var on upgrade.
for (const w of configWarnings(process.env)) log.warn(w)

const server = serve({ fetch: app.fetch, port: cfg.port }, () => {
  log.info("derive api listening", {
    port: cfg.port,
    base_url: cfg.baseUrl,
    // Name the HOST, not just the driver: "postgres" alone once read the same for a
    // local database and a production one, and nobody could tell for a day.
    meta: cfg.databaseUrl ? `postgres (${dbHost ?? "unparseable"})` : `sqlite (${cfg.dataDir})`,
    blobs: cfg.objectStoreUrl ? "S3/R2" : `local disk (${cfg.dataDir})`,
    web: cfg.serveWeb ? "bundled SPA" : "API only",
    spaces: `multi-workspace (bootstrap org ${defaultOrg})`,
    workers: cfg.backgroundWorkers ? "on" : "OFF (DERIVE_BACKGROUND_WORKERS=0)",
  })
})

// Graceful shutdown: Fly's auto-stop and every redeploy send SIGTERM. The sequence
// lives in lifecycle.ts (so it's unit-testable); here we just wire the real server,
// timers, and datastores to it. `in` narrows the http2/https union @hono/node-server
// returns to the plain http.Server we create (closeIdleConnections since Node 18.2).
const shutdown = makeShutdown({
  server: {
    close: (cb) => server.close(() => cb()),
    closeIdleConnections:
      "closeIdleConnections" in server ? () => server.closeIdleConnections() : undefined,
  },
  stopWorker: () => {
    webhookWorker?.stop()
    previewWorker?.stop()
  },
  clearTimers: () => {
    if (pruneTimer) clearInterval(pruneTimer)
    if (syncResumeTimer) clearInterval(syncResumeTimer)
    if (draftSweepTimer) clearInterval(draftSweepTimer)
  },
  closeStores,
  log,
  exit: (code) => process.exit(code),
})
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

// Last-resort crash safety: a stray rejection shouldn't vanish silently, and a
// truly uncaught exception should exit cleanly so the orchestrator restarts a
// fresh process rather than leaving a half-dead one serving 500s.
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  })
})
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { error: err.message, stack: err.stack })
  process.exit(1)
})
