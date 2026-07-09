import { mkdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { BlobStore, MetaStore } from "@derive/core"
import { PgMetaStore } from "@derive/db/pg"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { s3FromUrl } from "@derive/storage/s3"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { createApp } from "./app"
import { type AuthDb, makeAuth, migrateAuth, OAUTH_ANON_CLIENT_TTL_MS } from "./auth-config"
import { loadConfig, resolveAuthSecret, resolveDefaultOrg } from "./config"
import { configWarnings } from "./config-manifest"
import { workspacesBlockingDeletion } from "./lib/account"
import { customDomainsFromEnv } from "./lib/cloudflare-saas"
import { buildAuthEmail, emailDeliverySender, logEmailSender, resendEmailSender } from "./lib/email"
import { makeGithubCommentSender } from "./lib/github-comments"
import { mountWeb } from "./lib/serve-web"
import { makeSlackSender } from "./lib/slack-comments"
import { makeSlackDmSender } from "./lib/slack-dm"
import { makeShutdown } from "./lifecycle"
import { log } from "./log"
import { createNodeSyncRunner } from "./node-sync"
import { playwrightRenderer } from "./preview-node"
import { startPreviewWorker } from "./previews"
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
// e2e harness — into a writer against prod. It happened. `pnpm dev` runs under
// npm_lifecycle_event="dev"; deployments launch the entry directly, so they are
// unaffected by this gate.
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
if (remoteDb && process.env.npm_lifecycle_event === "dev") {
  if (!allowRemoteDbFromShell) {
    log.error(
      "refusing to start: dev mode with a remote DATABASE_URL (set DERIVE_ALLOW_REMOTE_DB=1 to override)",
      { host: dbHost ?? "unparseable" },
    )
    process.exit(1)
  }
  log.warn("dev mode is using a REMOTE database (DERIVE_ALLOW_REMOTE_DB=1)")
}

mkdirSync(join(cfg.dataDir, "blobs"), { recursive: true })

// Metadata + auth share one datastore: Postgres when DATABASE_URL is set (the
// stateless multi-instance topology), else embedded SQLite (zero-config).
let meta: MetaStore
let authDb: AuthDb
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
  closeStores = async () => {
    await pgMeta.close()
    await pool.end()
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
  closeStores = async () => {
    sqliteMeta.close()
    db.close()
  }
}

const authSecret = resolveAuthSecret(cfg.dataDir)
// A real transactional email transport (Resend) is configured — else the log sender
// still records each message (an operator can read a reset link from the container logs),
// but the SPA hides the self-serve mail flows (see `emailEnabled` in createApp deps).
const emailEnabled = !!(cfg.resendApiKey && cfg.emailFrom)
const auth = makeAuth(authDb, cfg.baseUrl, authSecret, {
  usernameTaken: (u) => meta.getUserByUsername(u).then(Boolean),
  // Render + enqueue transactional auth emails (reset / verify / change-email) onto the
  // same retrying outbox as notifications; the configured sender transports them.
  sendAuthEmail: (kind, input) =>
    enqueueChannelDelivery(meta, "email", `auth.${kind}`, buildAuthEmail(kind, input)),
  // Account deletion: block if they'd orphan a shared workspace, else purge domain data.
  blockUserDeletion: async (userId) => {
    const blocking = await workspacesBlockingDeletion(meta, userId)
    return blocking.length
      ? `Transfer ownership or remove the other members of ${blocking.join(", ")} before deleting your account.`
      : null
  },
  purgeUserData: (userId) => meta.deleteUserData(userId),
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

// The webhook outbox drainer: an interval delivers queued events with retries +
// backoff, and `poke` (wired into the app below) drains on demand so a fresh event
// goes out immediately. `nodeDnsGuard` re-resolves each target at delivery time and
// refuses private/internal addresses — the SSRF defense that matters most on an
// internal corporate network, where a webhook URL could point at a private service.
// First-party channel senders for the Node tier. Email uses Resend (over fetch) when
// RESEND_API_KEY is set, else the log sender (visible in dev, no transport needed).
// The edge tier wires the Cloudflare Email Service binding instead (see webhook-do.ts).
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
}
const webhookWorker = startWebhookWorker(meta, nodeDnsGuard, channelSenders)

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

const app = createApp({
  meta,
  blobs,
  baseUrl: cfg.baseUrl,
  shell: shellHtml,
  token: cfg.token,
  // Encrypt stored third-party secrets (GitHub PATs) at rest with the auth secret.
  encryptionKey: authSecret,
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
  // Per-actor write rate limits (per minute); unset = built-in defaults.
  publishRate: cfg.publishRate,
  commentRate: cfg.commentRate,
  // Deliver freshly enqueued events immediately instead of on the next interval.
  pokeWebhooks: webhookWorker.poke,
  // Enqueue a render job on publish and drain on demand when previews are enabled.
  renderPreviews: cfg.previews,
  pokePreviews: previewWorker?.poke,
  // Run a triggered GitHub sync in the background so it survives a closed tab.
  startSync: syncRunner.start,
})

// Serve the bundled SPA from this process (single-container self-host). The API
// routes above always win; the server-owned path set, the immutable-asset caching,
// and the index.html fallback live in mountWeb, shared as one contract with the
// edge Worker (wrangler.toml) and the dev proxy (serve-web.test asserts parity).
if (cfg.serveWeb && shellHtml !== undefined)
  mountWeb(app, {
    webRoot: relative(process.cwd(), cfg.webDir) || ".",
    shellHtml,
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
void maintain()
pruneTimer = setInterval(maintain, 24 * 3600_000)
pruneTimer.unref?.()

// Resume any GitHub sync left mid-flight: once on boot (a restart mid-sync) and on a
// short interval (a self-heal backstop, mirroring the edge cron). The persisted
// file-map makes resume idempotent, and the runner dedupes already-running loops, so
// this is safe to call repeatedly. unref'd so it never holds the process open.
void syncRunner.resumeStalled()
const syncResumeTimer = setInterval(() => void syncRunner.resumeStalled(), 60_000)
syncResumeTimer.unref?.()

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
    meta: cfg.databaseUrl ? "postgres" : `sqlite (${cfg.dataDir})`,
    blobs: cfg.objectStoreUrl ? "S3/R2" : `local disk (${cfg.dataDir})`,
    web: cfg.serveWeb ? "bundled SPA" : "API only",
    spaces: `multi-workspace (bootstrap org ${defaultOrg})`,
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
    webhookWorker.stop()
    previewWorker?.stop()
  },
  clearTimers: () => {
    if (pruneTimer) clearInterval(pruneTimer)
    clearInterval(syncResumeTimer)
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
