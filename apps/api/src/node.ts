import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
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
import { startWebhookWorker } from "./webhooks"

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = process.env.DATA_DIR ?? "./data"

/** Parse a positive integer env var; undefined (unset/blank/≤0/NaN) = "no limit". */
const posInt = (v: string | undefined): number | undefined => {
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
// The public origin: explicit BASE_URL wins; otherwise infer the URL a managed
// host assigned us (Railway/Render/Fly) so a one-click deploy gets working auth
// cookies + share links without anyone hand-typing the domain. Localhost is the
// last resort. Override BASE_URL once you point a custom domain at it.
const inferredBaseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : process.env.FLY_APP_NAME
      ? `https://${process.env.FLY_APP_NAME}.fly.dev`
      : `http://localhost:${PORT}`
const BASE_URL = process.env.BASE_URL ?? inferredBaseUrl
const DATABASE_URL = process.env.DATABASE_URL

// Single-container self-host: when the web SPA has been built (Docker image, or
// `pnpm --filter @dock/web build` locally), this same process serves it so the
// whole app lives at one origin — no CDN, no CORS, no cross-site cookies.
// DOCK_WEB_DIR overrides; default is the build output relative to this file.
const WEB_DIR = resolve(
  process.env.DOCK_WEB_DIR ?? join(import.meta.dirname, "../../web/dist/client"),
)
// TanStack Start's SPA build emits `_shell.html` (the prerendered shell every
// route hydrates from), not index.html.
const WEB_SHELL = join(WEB_DIR, "_shell.html")
const SERVE_WEB = existsSync(WEB_SHELL)

mkdirSync(join(DATA_DIR, "blobs"), { recursive: true })

// Metadata + auth share one datastore: Postgres when DATABASE_URL is set (the
// stateless multi-instance topology), else embedded SQLite (zero-config).
let meta: MetaStore
let authDb: AuthDb
if (DATABASE_URL) {
  meta = await PgMetaStore.create(DATABASE_URL)
  authDb = new Pool({ connectionString: DATABASE_URL })
} else {
  meta = new SqliteMetaStore(join(DATA_DIR, "dock.db"))
  authDb = new Database(join(DATA_DIR, "dock.db"))
}
// A stable session-signing secret: an explicit DOCK_AUTH_SECRET wins; otherwise
// generate one and persist it beside the data so zero-config self-host stays
// secure across restarts. (Multi-instance Postgres deployments must set the env
// so every instance shares the same secret.)
const AUTH_SECRET = ((): string => {
  const fromEnv = process.env.DOCK_AUTH_SECRET
  if (fromEnv && fromEnv.length >= 16) return fromEnv
  const file = join(DATA_DIR, ".auth-secret")
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim()
  } catch {
    /* fall through and generate */
  }
  const generated = randomBytes(32).toString("hex")
  try {
    writeFileSync(file, generated, { mode: 0o600 })
    console.warn(
      `DOCK_AUTH_SECRET not set; generated one at ${file}. Set DOCK_AUTH_SECRET to control it (required for multi-instance deployments).`,
    )
  } catch {
    throw new Error(
      "DOCK_AUTH_SECRET is unset and no secret could be persisted; set DOCK_AUTH_SECRET",
    )
  }
  return generated
})()
const auth = makeAuth(authDb, BASE_URL, AUTH_SECRET)
await migrateAuth(auth)

// The bootstrap workspace id — a real, persisted value (never a magic literal),
// so turning on multi-workspace later needs no data change. DOCK_DEFAULT_ORG_ID
// wins; otherwise generate one and persist it beside the data, like the auth secret.
const DEFAULT_ORG = ((): string => {
  const fromEnv = process.env.DOCK_DEFAULT_ORG_ID
  if (fromEnv) return fromEnv
  const file = join(DATA_DIR, ".org-id")
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim()
  } catch {
    /* fall through and generate */
  }
  const generated = `ws_${randomBytes(12).toString("hex")}`
  try {
    writeFileSync(file, generated, { mode: 0o600 })
  } catch {
    /* best-effort; a fresh id next boot is harmless on an empty store */
  }
  return generated
})()

// One-time rekey of the pre-multi-workspace "local" sentinel onto the real
// default org id. Idempotent (no rows remain on 'local' afterward) and a no-op
// for fresh installs and hosted Postgres that never used 'local'.
if (DEFAULT_ORG !== "local") {
  const orgTables = ["membership", "artifact", "collection", "agent"]
  if (DATABASE_URL) {
    const pool = authDb as Pool
    for (const t of orgTables)
      await pool.query(`UPDATE "${t}" SET org_id = $1 WHERE org_id = 'local'`, [DEFAULT_ORG])
    await pool.query(`UPDATE workspace SET id = $1 WHERE id = 'local'`, [DEFAULT_ORG])
  } else {
    const db = authDb as Database.Database
    for (const t of orgTables)
      db.prepare(`UPDATE ${t} SET org_id = ? WHERE org_id = 'local'`).run(DEFAULT_ORG)
    db.prepare(`UPDATE workspace SET id = ? WHERE id = 'local'`).run(DEFAULT_ORG)
  }
}

// Multi-workspace: off by default (self-host is single-workspace); the hosted
// product sets DOCK_MULTI_WORKSPACE=true to unlock create/switch.
const MULTI_WORKSPACE = process.env.DOCK_MULTI_WORKSPACE === "true"

const webOrigins = (process.env.DOCK_WEB_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// Blobs: S3/R2 when OBJECT_STORE_URL is set, else local disk (zero-config).
const blobs: BlobStore = process.env.OBJECT_STORE_URL
  ? s3FromUrl(process.env.OBJECT_STORE_URL)
  : new FsBlobStore(join(DATA_DIR, "blobs"))

const app = createApp({
  meta,
  blobs,
  baseUrl: BASE_URL,
  token: process.env.DOCK_TOKEN,
  auth,
  webOrigins,
  analytics: process.env.DOCK_ANALYTICS !== "false",
  rateLimit: process.env.DOCK_RATE_LIMIT !== "false",
  serveWeb: SERVE_WEB,
  multiWorkspace: MULTI_WORKSPACE,
  defaultOrgId: DEFAULT_ORG,
  // Origin isolation: serve artifact bytes from a separate registrable domain
  // pointed at this same container. Keeps user HTML off the app's cookie origin.
  sandboxOrigin: process.env.DOCK_SANDBOX_URL,
  crossSite: process.env.DOCK_CROSS_SITE === "true",
  versionWindowMs: process.env.DOCK_VERSION_WINDOW
    ? Number(process.env.DOCK_VERSION_WINDOW) * 60_000
    : undefined,
  // Storage backstops: unset = unlimited (self-host stays open).
  maxArtifacts: posInt(process.env.DOCK_MAX_ARTIFACTS),
  maxBytes: posInt(process.env.DOCK_MAX_BYTES),
  // Per-actor write rate limits (per minute); unset = built-in defaults.
  publishRate: posInt(process.env.DOCK_PUBLISH_RATE),
  commentRate: posInt(process.env.DOCK_COMMENT_RATE),
})

// Serve the bundled SPA from this process (single-container self-host). The API
// routes above always win; static assets are served by hash (immutable), and any
// other GET that isn't an API/asset path falls back to index.html so the client
// router can take over (deep links, refresh). serveStatic roots are cwd-relative.
if (SERVE_WEB) {
  const webRoot = relative(process.cwd(), WEB_DIR) || "."
  const shellHtml = readFileSync(WEB_SHELL, "utf8")
  app.use("/assets/*", serveStatic({ root: webRoot }))
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
const RETENTION_DAYS = Number(process.env.DOCK_ANALYTICS_RETENTION_DAYS ?? 365)
if (RETENTION_DAYS > 0) {
  const prune = () =>
    meta.pruneViews(new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString()).catch(() => 0)
  void prune()
  setInterval(prune, 24 * 3600_000).unref?.()
}

// One-time cleanup of pre-existing owner self-views (the route no longer records
// them). Owners are workspace members with the `owner` role; match their id, name
// and email so rows from before the id-based identity change are caught too.
void (async () => {
  try {
    const owners = (await meta.listMemberships("local")).filter((m) => m.role === "owner")
    if (owners.length === 0) return
    const users = await meta.getUsers(owners.map((m) => m.user_id))
    const viewers = [
      ...new Set(users.flatMap((u) => [u.id, u.name, u.email].filter((v): v is string => !!v))),
    ]
    const removed = await meta.pruneViewsByViewers(viewers)
    if (removed > 0) console.log(`analytics: removed ${removed} owner self-view(s)`)
  } catch {
    /* best-effort; never blocks boot */
  }
})()

const blobDesc = process.env.OBJECT_STORE_URL ? "S3/R2" : `local disk (${DATA_DIR})`
const metaDesc = DATABASE_URL ? "postgres" : `sqlite (${DATA_DIR})`

// Loud warning for the footgun: a cross-site / public-looking deployment that
// serves untrusted artifact HTML on its own origin (no separate sandbox host).
// Single-origin self-host is a supported mode (the iframe sandbox is the wall);
// a cross-site setup without isolation is not.
if (
  !process.env.DOCK_SANDBOX_URL &&
  (process.env.DOCK_CROSS_SITE === "true" || webOrigins.length)
) {
  console.warn(
    "⚠ DOCK_SANDBOX_URL is unset on a cross-site deployment. Artifact HTML will be served from the app origin; set DOCK_SANDBOX_URL to a separate domain to isolate untrusted content from session cookies.",
  )
}

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`dock api listening on :${PORT}`)
  console.log(`  meta:    ${metaDesc}`)
  console.log(`  blobs:   ${blobDesc}`)
  console.log(`  auth:    /api/auth/* (Better Auth)`)
  console.log(`  web:     ${SERVE_WEB ? `bundled SPA at ${BASE_URL}` : "not bundled (API only)"}`)
  console.log(`  spaces:  ${MULTI_WORKSPACE ? "multi-workspace" : `single (org ${DEFAULT_ORG})`}`)
  console.log(`  publish: dock publish <file|dir> --server ${BASE_URL}`)
})
