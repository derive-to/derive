import { mkdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { BlobStore, MetaStore } from "@dock/core"
import { PgMetaStore } from "@dock/db/pg"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { s3FromUrl } from "@dock/storage/s3"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { createApp } from "./app"
import { type AuthDb, makeAuth, migrateAuth } from "./auth-config"
import { loadConfig, resolveAuthSecret, resolveDefaultOrg } from "./config"
import { log } from "./log"
import { startWebhookWorker } from "./webhooks"

const cfg = loadConfig()
mkdirSync(join(cfg.dataDir, "blobs"), { recursive: true })

// Metadata + auth share one datastore: Postgres when DATABASE_URL is set (the
// stateless multi-instance topology), else embedded SQLite (zero-config).
let meta: MetaStore
let authDb: AuthDb
if (cfg.databaseUrl) {
  meta = await PgMetaStore.create(cfg.databaseUrl)
  authDb = new Pool({ connectionString: cfg.databaseUrl })
} else {
  meta = new SqliteMetaStore(join(cfg.dataDir, "dock.db"))
  authDb = new Database(join(cfg.dataDir, "dock.db"))
  // Better Auth opens its own connection to the same dock.db. Match the store's
  // WAL + busy_timeout so concurrent auth writes (e.g. bursts of signups) wait
  // for the lock instead of failing with SQLITE_BUSY.
  authDb.pragma("journal_mode = WAL")
  authDb.pragma("busy_timeout = 5000")
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

const app = createApp({
  meta,
  blobs,
  baseUrl: cfg.baseUrl,
  token: cfg.token,
  // Secure by default: anonymous callers are locked unless DOCK_OPEN=true is set
  // explicitly. Without this the context falls back to `!token` (open when no
  // token), which let anonymous publish on a no-token container — the edge worker
  // already passes an explicit `open`, so this makes both entrypoints consistent.
  open: cfg.open,
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
  versionWindowMs: cfg.versionWindowMs,
  // Storage backstops: unset = unlimited (self-host stays open).
  maxArtifacts: cfg.maxArtifacts,
  maxBytes: cfg.maxBytes,
  // Per-actor write rate limits (per minute); unset = built-in defaults.
  publishRate: cfg.publishRate,
  commentRate: cfg.commentRate,
})

// Serve the bundled SPA from this process (single-container self-host). The API
// routes above always win; static assets are served by hash (immutable), and any
// other GET that isn't an API/asset path falls back to index.html so the client
// router can take over (deep links, refresh). serveStatic roots are cwd-relative.
if (cfg.serveWeb) {
  const webRoot = relative(process.cwd(), cfg.webDir) || "."
  const shellHtml = readFileSync(cfg.webShell, "utf8")
  // Vite's /assets/* are content-hashed, so the bytes behind a URL never change
  // — cache them hard (a year, immutable). A new build emits new hashes.
  app.use(
    "/assets/*",
    serveStatic({
      root: webRoot,
      onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  )
  // Root-level static files Vite emits (favicon, manifest, etc.).
  app.get("/:file{[^/]+\\.[^/]+}", serveStatic({ root: webRoot }))
  app.notFound((c) => {
    const p = c.req.path
    if (p.startsWith("/v1") || p.startsWith("/api") || p.startsWith("/raw") || p === "/healthz")
      return c.json({ error: "not found" }, 404)
    return c.html(shellHtml)
  })
}

// The webhook outbox worker delivers queued events with retries + backoff.
startWebhookWorker(meta)

// Analytics retention: views are a rolling window (default 365 days). A daily
// prune keeps the append-only view table bounded. 0 disables pruning entirely.
if (cfg.retentionDays > 0) {
  const prune = () =>
    meta
      .pruneViews(new Date(Date.now() - cfg.retentionDays * 86400_000).toISOString())
      .catch(() => 0)
  void prune()
  setInterval(prune, 24 * 3600_000).unref?.()
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

serve({ fetch: app.fetch, port: cfg.port }, () => {
  log.info("dock api listening", {
    port: cfg.port,
    base_url: cfg.baseUrl,
    meta: cfg.databaseUrl ? "postgres" : `sqlite (${cfg.dataDir})`,
    blobs: cfg.objectStoreUrl ? "S3/R2" : `local disk (${cfg.dataDir})`,
    web: cfg.serveWeb ? "bundled SPA" : "API only",
    spaces: `multi-workspace (bootstrap org ${defaultOrg})`,
  })
})
