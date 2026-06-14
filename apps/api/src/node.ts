import { mkdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { BlobStore, MetaStore } from "@dock/core"
import { PgMetaStore } from "@dock/db/pg"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { s3FromUrl } from "@dock/storage/s3"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { createApp } from "./app"
import { type AuthDb, makeAuth, migrateAuth } from "./auth-config"
import { loadConfig, resolveAuthSecret, resolveDefaultOrg } from "./config"
import { mountWeb } from "./lib/serve-web"
import { log } from "./log"
import { startWebhookWorker } from "./webhooks"

const cfg = loadConfig()
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
  const db = new Database(join(cfg.dataDir, "dock.db"))
  // Better Auth opens its own connection to the same dock.db. Match the store's
  // WAL + busy_timeout so concurrent auth writes (e.g. bursts of signups) wait
  // for the lock instead of failing with SQLITE_BUSY.
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")
  const sqliteMeta = new SqliteMetaStore(join(cfg.dataDir, "dock.db"))
  meta = sqliteMeta
  authDb = db
  closeStores = async () => {
    sqliteMeta.close()
    db.close()
  }
}

const auth = makeAuth(authDb, cfg.baseUrl, resolveAuthSecret(cfg.dataDir))
await migrateAuth(auth)

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

// Blobs: S3/R2 when OBJECT_STORE_URL is set, else local disk (zero-config).
const blobs: BlobStore = cfg.objectStoreUrl
  ? s3FromUrl(cfg.objectStoreUrl)
  : new FsBlobStore(join(cfg.dataDir, "blobs"))

// The SPA shell, read once: passed to createApp (so /a/:ref can inject unfurl
// meta) and to mountWeb (the client-router fallback). Only when serving the web.
const shellHtml = cfg.serveWeb ? readFileSync(cfg.webShell, "utf8") : undefined

const app = createApp({
  meta,
  blobs,
  baseUrl: cfg.baseUrl,
  shell: shellHtml,
  token: cfg.token,
  superAdmins: cfg.superAdmins,
  auth,
  webOrigins: cfg.webOrigins,
  analytics: cfg.analytics,
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
  versionWindowMs: cfg.versionWindowMs,
  // Storage backstops: unset = unlimited (self-host stays open).
  maxArtifacts: cfg.maxArtifacts,
  maxBytes: cfg.maxBytes,
  // Per-actor write rate limits (per minute); unset = built-in defaults.
  publishRate: cfg.publishRate,
  commentRate: cfg.commentRate,
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

// The webhook outbox worker delivers queued events with retries + backoff.
const stopWorker = startWebhookWorker(meta)

// Analytics retention: views are a rolling window (default 365 days). A daily
// prune keeps the append-only view table bounded. 0 disables pruning entirely.
let pruneTimer: ReturnType<typeof setInterval> | undefined
if (cfg.retentionDays > 0) {
  const prune = () =>
    meta
      .pruneViews(new Date(Date.now() - cfg.retentionDays * 86400_000).toISOString())
      .catch(() => 0)
  void prune()
  pruneTimer = setInterval(prune, 24 * 3600_000)
  pruneTimer.unref?.()
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
    "DOCK_SANDBOX_URL is unset on a cross-site deployment. Artifact HTML will be served from the app origin; set DOCK_SANDBOX_URL to a separate domain to isolate untrusted content from session cookies.",
  )
}

const server = serve({ fetch: app.fetch, port: cfg.port }, () => {
  log.info("dock api listening", {
    port: cfg.port,
    base_url: cfg.baseUrl,
    meta: cfg.databaseUrl ? "postgres" : `sqlite (${cfg.dataDir})`,
    blobs: cfg.objectStoreUrl ? "S3/R2" : `local disk (${cfg.dataDir})`,
    web: cfg.serveWeb ? "bundled SPA" : "API only",
    spaces: `multi-workspace (bootstrap org ${defaultOrg})`,
  })
})

// Graceful shutdown: Fly's auto-stop and every redeploy send SIGTERM. Stop the
// worker + timers, stop accepting connections and drain in-flight requests, close
// the datastores, then exit — instead of Node's default of dropping everything.
let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  log.info("shutting down", { signal })
  // Hard deadline so a hung drain can't wedge the orchestrator forever.
  setTimeout(() => {
    log.error("shutdown timed out; forcing exit")
    process.exit(1)
  }, 10_000).unref()
  stopWorker()
  if (pruneTimer) clearInterval(pruneTimer)
  // server.close() stops accepting connections and resolves once existing ones end,
  // but Node never closes IDLE keep-alive sockets on its own — a browser, a load
  // balancer, or any client holding one keeps close() pending until the hard
  // deadline force-exits (a 10s stall on every redeploy). closeIdleConnections drops
  // those now; in-flight requests keep their socket and still drain.
  const drained = new Promise<void>((resolve) => server.close(() => resolve()))
  // `in` narrows the http2/https union @hono/node-server returns; our serve() is a
  // plain http.Server, which has had closeIdleConnections since Node 18.2.
  if ("closeIdleConnections" in server) server.closeIdleConnections()
  await drained
  try {
    await closeStores()
  } catch (e) {
    log.error("error closing datastores", { error: e instanceof Error ? e.message : String(e) })
  }
  log.info("shutdown complete")
  process.exit(0)
}
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
