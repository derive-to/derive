import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { log } from "./log"

/** Parse a positive integer env var; undefined (unset/blank/≤0/NaN) = "no limit". */
const posInt = (v: string | undefined): number | undefined => {
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/** The fully-resolved, validated runtime configuration. Read once at boot from
 *  the environment so the rest of the entrypoint never touches `process.env`. */
export interface Config {
  port: number
  dataDir: string
  baseUrl: string
  databaseUrl?: string
  token?: string
  /** Operator (instance super-admin) emails: these accounts get global powers
   *  (cross-workspace takedown, the global reports/audit queue) on top of the
   *  DOCK_TOKEN bearer. The people who run + host the deployment. */
  superAdmins: string[]
  analytics: boolean
  rateLimit: boolean
  multiWorkspace: boolean
  sandboxOrigin?: string
  crossSite: boolean
  versionWindowMs?: number
  maxArtifacts?: number
  maxBytes?: number
  publishRate?: number
  commentRate?: number
  webOrigins: string[]
  retentionDays: number
  objectStoreUrl?: string
  webDir: string
  webShell: string
  serveWeb: boolean
}

/**
 * Build the config from the environment, failing fast on anything malformed.
 * The public origin: explicit BASE_URL wins; otherwise infer the URL a managed
 * host assigned us (Railway/Render/Fly) so a one-click deploy gets working auth
 * cookies + share links without anyone hand-typing the domain. Localhost is the
 * last resort. Override BASE_URL once you point a custom domain at it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT: ${env.PORT}`)

  const inferredBaseUrl = env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
    : env.RENDER_EXTERNAL_URL
      ? env.RENDER_EXTERNAL_URL
      : env.FLY_APP_NAME
        ? `https://${env.FLY_APP_NAME}.fly.dev`
        : `http://localhost:${port}`
  const baseUrl = env.BASE_URL ?? inferredBaseUrl
  try {
    new URL(baseUrl)
  } catch {
    throw new Error(`invalid BASE_URL: ${baseUrl}`)
  }

  const dataDir = env.DATA_DIR ?? "./data"
  // Single-container self-host: when the web SPA has been built, this process
  // serves it. DOCK_WEB_DIR overrides; default is the build output beside us.
  // TanStack Start's SPA build emits `_shell.html` (not index.html).
  const webDir = resolve(env.DOCK_WEB_DIR ?? join(import.meta.dirname, "../../web/dist/client"))
  const webShell = join(webDir, "_shell.html")

  const webOrigins = (env.DOCK_WEB_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    port,
    dataDir,
    baseUrl,
    databaseUrl: env.DATABASE_URL,
    token: env.DOCK_TOKEN,
    // Comma-separated operator emails (case-insensitive). More than one person
    // can run + host a deployment, so this is a list, not a single owner.
    superAdmins: (env.DOCK_SUPERADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    analytics: env.DOCK_ANALYTICS !== "false",
    rateLimit: env.DOCK_RATE_LIMIT !== "false",
    multiWorkspace: env.DOCK_MULTI_WORKSPACE === "true",
    sandboxOrigin: env.DOCK_SANDBOX_URL,
    crossSite: env.DOCK_CROSS_SITE === "true",
    versionWindowMs: env.DOCK_VERSION_WINDOW ? Number(env.DOCK_VERSION_WINDOW) * 60_000 : undefined,
    maxArtifacts: posInt(env.DOCK_MAX_ARTIFACTS),
    maxBytes: posInt(env.DOCK_MAX_BYTES),
    publishRate: posInt(env.DOCK_PUBLISH_RATE),
    commentRate: posInt(env.DOCK_COMMENT_RATE),
    webOrigins,
    retentionDays: Number(env.DOCK_ANALYTICS_RETENTION_DAYS ?? 365),
    objectStoreUrl: env.OBJECT_STORE_URL,
    webDir,
    webShell,
    serveWeb: existsSync(webShell),
  }
}

/**
 * A stable session-signing secret: an explicit DOCK_AUTH_SECRET wins; otherwise
 * generate one and persist it beside the data so zero-config self-host stays
 * secure across restarts. (Multi-instance Postgres deployments must set the env
 * so every instance shares the same secret.)
 */
export function resolveAuthSecret(dataDir: string): string {
  const fromEnv = process.env.DOCK_AUTH_SECRET
  if (fromEnv && fromEnv.length >= 16) return fromEnv
  const file = join(dataDir, ".auth-secret")
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim()
  } catch {
    /* fall through and generate */
  }
  const generated = randomBytes(32).toString("hex")
  try {
    writeFileSync(file, generated, { mode: 0o600 })
    log.warn(
      `DOCK_AUTH_SECRET not set; generated one at ${file}. Set it to control the value (required for multi-instance deployments).`,
    )
  } catch {
    throw new Error(
      "DOCK_AUTH_SECRET is unset and no secret could be persisted; set DOCK_AUTH_SECRET",
    )
  }
  return generated
}

/**
 * The bootstrap workspace id — a real, persisted value (never a magic literal),
 * so turning on multi-workspace later needs no data change. DOCK_DEFAULT_ORG_ID
 * wins; otherwise generate one and persist it beside the data, like the secret.
 */
export function resolveDefaultOrg(dataDir: string): string {
  const fromEnv = process.env.DOCK_DEFAULT_ORG_ID
  if (fromEnv) return fromEnv
  const file = join(dataDir, ".org-id")
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
}
