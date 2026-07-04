import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { slackFromEnv, subdomainBaseFromEnv, superAdminsFromEnv } from "./lib/env"
import { log } from "./log"

/** Parse a positive-integer env var; unset/blank = "no limit". A set-but-invalid
 *  value is a likely typo, so warn loudly rather than silently ignore it. */
const posInt = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`ignoring invalid ${name}=${v} (expected a positive integer)`)
    return undefined
  }
  return Math.floor(n)
}

/** A required-with-default numeric env var; a malformed value fails fast at boot. */
const numOr = (name: string, v: string | undefined, def: number): number => {
  if (v === undefined || v === "") return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`invalid ${name}: ${v} (expected a number)`)
  return n
}

/** Validate that an optional env var parses as a URL; a typo fails fast at boot
 *  rather than lazily on the first request that touches the DB / blob store. */
const urlOr = (name: string, v: string | undefined): string | undefined => {
  if (!v) return undefined
  try {
    new URL(v)
  } catch {
    throw new Error(`invalid ${name}: ${v} (expected a URL)`)
  }
  return v
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
   *  DERIVE_TOKEN bearer. The people who run + host the deployment. */
  superAdmins: string[]
  analytics: boolean
  rateLimit: boolean
  sandboxOrigin?: string
  crossSite: boolean
  /** Base domain for vanity subdomains (e.g. "derived.app"): an artifact assigned
   *  `q3.derived.app` is served at that host's root. Unset = subdomain mode off. */
  subdomainBase?: string
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
  /** From-address for notification emails (e.g. "Derive <notifications@derive.to>").
   *  Unset ⇒ email notifications are logged, not sent (the zero-config default). */
  emailFrom?: string
  /** Resend API key for self-host email delivery over fetch (no SDK). Unset ⇒ the
   *  log sender. The edge uses the Cloudflare Email Service binding instead. */
  resendApiKey?: string
  /** Slack App credentials (connect flow + Events API). All three set ⇒ Slack on. */
  slack?: { clientId: string; clientSecret: string; signingSecret: string }
}

/**
 * Build the config from the environment, failing fast on anything malformed.
 * The public origin: explicit BASE_URL wins; otherwise infer the URL a managed
 * host assigned us (Railway/Render/Fly) so a one-click deploy gets working auth
 * cookies + share links without anyone hand-typing the domain. Localhost is the
 * last resort. Override BASE_URL once you point a custom domain at it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Local-dev default. Every container/platform deploy sets PORT explicitly
  // (Dockerfile, compose, fly.toml all pin 8080), so this fallback only governs
  // `pnpm dev` on a workstation — hence an uncommon port that rarely collides.
  const port = Number(env.PORT ?? 8090)
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
  // serves it. DERIVE_WEB_DIR overrides; default is the build output beside us.
  // TanStack Start's SPA build emits `_shell.html`; the edge prep copies it to
  // `index.html`. Accept either (preferring `index.html`) so the bundled-SPA
  // server and the Worker agree on one shell, whatever the build left behind.
  const webDir = resolve(env.DERIVE_WEB_DIR ?? join(import.meta.dirname, "../../web/dist/client"))
  const webShell =
    [join(webDir, "index.html"), join(webDir, "_shell.html")].find(existsSync) ??
    join(webDir, "_shell.html")

  const webOrigins = (env.DERIVE_WEB_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    port,
    dataDir,
    baseUrl,
    databaseUrl: urlOr("DATABASE_URL", env.DATABASE_URL),
    token: env.DERIVE_TOKEN,
    // Comma-separated operator emails (case-insensitive). More than one person
    // can run + host a deployment, so this is a list, not a single owner.
    superAdmins: superAdminsFromEnv(env),
    analytics: env.DERIVE_ANALYTICS !== "false",
    rateLimit: env.DERIVE_RATE_LIMIT !== "false",
    sandboxOrigin: env.DERIVE_SANDBOX_URL,
    crossSite: env.DERIVE_CROSS_SITE === "true",
    subdomainBase: subdomainBaseFromEnv(env),
    versionWindowMs: env.DERIVE_VERSION_WINDOW
      ? numOr("DERIVE_VERSION_WINDOW", env.DERIVE_VERSION_WINDOW, 0) * 60_000
      : undefined,
    maxArtifacts: posInt("DERIVE_MAX_ARTIFACTS", env.DERIVE_MAX_ARTIFACTS),
    maxBytes: posInt("DERIVE_MAX_BYTES", env.DERIVE_MAX_BYTES),
    publishRate: posInt("DERIVE_PUBLISH_RATE", env.DERIVE_PUBLISH_RATE),
    commentRate: posInt("DERIVE_COMMENT_RATE", env.DERIVE_COMMENT_RATE),
    webOrigins,
    retentionDays: numOr(
      "DERIVE_ANALYTICS_RETENTION_DAYS",
      env.DERIVE_ANALYTICS_RETENTION_DAYS,
      365,
    ),
    objectStoreUrl: urlOr("OBJECT_STORE_URL", env.OBJECT_STORE_URL),
    emailFrom: env.EMAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
    slack: slackFromEnv(env),
    webDir,
    webShell,
    serveWeb: existsSync(webShell),
  }
}

/**
 * A stable session-signing secret: an explicit DERIVE_AUTH_SECRET wins; otherwise
 * generate one and persist it beside the data so zero-config self-host stays
 * secure across restarts. (Multi-instance Postgres deployments must set the env
 * so every instance shares the same secret.)
 */
export function resolveAuthSecret(dataDir: string): string {
  const fromEnv = process.env.DERIVE_AUTH_SECRET
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
      `DERIVE_AUTH_SECRET not set; generated one at ${file}. Set it to control the value (required for multi-instance deployments).`,
    )
  } catch {
    throw new Error(
      "DERIVE_AUTH_SECRET is unset and no secret could be persisted; set DERIVE_AUTH_SECRET",
    )
  }
  return generated
}

/**
 * The bootstrap workspace id — a real, persisted value (never a magic literal),
 * so turning on multi-workspace later needs no data change. DERIVE_DEFAULT_ORG_ID
 * wins; otherwise generate one and persist it beside the data, like the secret.
 */
export function resolveDefaultOrg(dataDir: string): string {
  const fromEnv = process.env.DERIVE_DEFAULT_ORG_ID
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
