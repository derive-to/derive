// THE single source of truth for server configuration.
//
// Every env var the server reads is declared here once — its group, docs, and (for
// capability vars) which feature it gates. Everything downstream DERIVES from this:
//   - `.env.example`      is generated (genEnvExample + a snapshot test); never hand-edited.
//   - the capability report (boot warnings, `derive doctor`, /v1/auth/capabilities) reads
//     `capabilityReport` / `statusOf` — one gating rule, not a copy per surface.
//
// Pure and edge-safe (no Node builtins) so any runtime can import it. Adding a var? Add it
// here and run `pnpm --filter @derive/api gen:env`; `check-env` fails CI if the code reads
// a var this manifest (via the generated .env.example) doesn't declare.

export type Env = Record<string, string | undefined>

// ---- Groups (sections in the generated .env.example) ----------------------
interface Group {
  id: string
  /** Section header in .env.example; the first group (core) omits a header. */
  title?: string
  /** A trailing note for the group (e.g. "repo sync needs no env"). */
  note?: string
}

export const GROUPS: Group[] = [
  { id: "core", title: undefined },
  { id: "limits", title: "Analytics, limits & quotas" },
  { id: "auth", title: "Auth (Better Auth)" },
  { id: "hosting", title: "Origin isolation & custom domains" },
  { id: "email", title: "Email (verification, password reset, invites)" },
  {
    id: "providers",
    title: "Sign-in providers (OAuth / SSO)",
    note: "GitHub repo sync needs no env: the GitHub App is registered one-click from\nSettings → GitHub (manifest flow) and its credentials are encrypted at rest with\nDERIVE_AUTH_SECRET. (That key must be set for repo sync via the App to work.)",
  },
  { id: "slack", title: "Slack (connect + reply-back)" },
  { id: "advanced", title: "Advanced" },
]

// ---- Var declarations -----------------------------------------------------
export interface ConfigVar {
  name: string
  group: string
  /** Prose for the generated .env.example (and docs). May be multi-line. */
  doc: string
  /** Value shown after `=` (a real default when `active`, else an illustrative example). */
  example?: string
  /** Shown uncommented with its default (the zero-config baseline); else commented out. */
  active?: boolean
  /** A credential — never echo a value (docs/doctor). */
  secret?: boolean
}

export const CONFIG_VARS: ConfigVar[] = [
  // -- core & storage --
  {
    name: "PORT",
    group: "core",
    doc: "Where the server listens. 8080 is the conventional self-host/container port (what\nthe deploy configs pin). Local `pnpm dev` uses 8090 unless you set PORT here.",
    example: "8080",
    active: true,
  },
  {
    name: "BASE_URL",
    group: "core",
    doc: "The public origin used for auth cookies and share links. On Railway/Render/Fly it's\ninferred from the platform's domain; set it explicitly for a custom domain.",
    example: "http://localhost:8080",
    active: true,
  },
  {
    name: "DATA_DIR",
    group: "core",
    doc: "Default storage: SQLite + local blobs inside one directory.",
    example: "./data",
    active: true,
  },
  {
    name: "DERIVE_WEB_DIR",
    group: "core",
    doc: "Where the built web SPA is served from. Default: the client build output next to the\nserver. Override only if you relocate the bundle.",
    example: "/app/apps/web/dist/client",
  },
  {
    name: "OBJECT_STORE_URL",
    group: "core",
    doc: "Optional S3-compatible object storage for blobs (AWS S3, Cloudflare R2, MinIO, GCS).\nAddressing + region auto-pick from the host; TLS on unless tls=false or localhost.\n  AWS:   s3://<key>:<secret>@s3.<region>.amazonaws.com/derive   (region from host)\n  R2:    s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/derive?region=auto\n  MinIO: s3://minioadmin:minioadmin@localhost:9000/derive?region=us-east-1&tls=false",
    example: "s3://ACCESS_KEY:SECRET_KEY@host/bucket?region=auto",
    secret: true,
  },
  {
    name: "DATABASE_URL",
    group: "core",
    doc: "Optional Postgres for metadata instead of the default embedded SQLite.",
    example: "postgres://user:pass@host:5432/derive",
    secret: true,
  },
  {
    name: "DERIVE_ALLOW_REMOTE_DB",
    group: "core",
    doc: "Safety gate: pointing DATABASE_URL at a REMOTE host during local `pnpm dev` is blocked\nby default, so a dev machine can't accidentally mutate a production database. Set to 1\nto allow a remote DB in dev. No effect in production.",
    example: "1",
  },
  {
    name: "DERIVE_TOKEN",
    group: "core",
    doc: "A static bearer token for headless CI/agent writes (and reading gated artifacts).\nSigned-in users can always write; anonymous callers are read-only either way.",
    example: "",
    secret: true,
  },

  // -- analytics, limits & quotas --
  {
    name: "DERIVE_ANALYTICS",
    group: "limits",
    doc: "View analytics (counts, unique viewers, timeline) are on by default. Set false to\ndisable recording + the analytics endpoints entirely.",
    example: "false",
  },
  {
    name: "DERIVE_ANALYTICS_RETENTION_DAYS",
    group: "limits",
    doc: "Views are a rolling window; a daily prune drops rows older than this many days.\nDefault 365; set 0 to keep everything.",
    example: "365",
  },
  {
    name: "DERIVE_VERSION_WINDOW",
    group: "limits",
    doc: "How long (in minutes) a burst of consecutive auto-saved versions collapses into one\ndisplay group in the history UI. Unset = built-in default. Storage, @vN URLs, and\nanalytics stay at per-version granularity regardless.",
    example: "30",
  },
  {
    name: "DERIVE_RATE_LIMIT",
    group: "limits",
    doc: "Per-IP rate limiting on auth + mutating routes is ON by default; set false to disable\n(e.g. behind your own gateway). Turning it off also disables the per-actor limits below.",
    example: "false",
  },
  {
    name: "DERIVE_BREACH_CHECK",
    group: "limits",
    doc: "Reject known-breached passwords at sign-up / reset / change (Have I Been Pwned,\nk-anonymity — the password never leaves the server). ON by default and FAILS OPEN (an\nair-gapped host is never blocked). Set false to disable the check entirely.",
    example: "false",
  },
  {
    name: "DERIVE_PUBLISH_RATE",
    group: "limits",
    doc: "Per-actor publish limit, actions per minute (signed-in user/agent, falling back to IP).\nUnset = built-in default (30).",
    example: "30",
  },
  {
    name: "DERIVE_COMMENT_RATE",
    group: "limits",
    doc: "Per-actor comment limit, actions per minute. Unset = built-in default (60).",
    example: "60",
  },
  {
    name: "DERIVE_MAX_ARTIFACTS",
    group: "limits",
    doc: "Workspace cap on the number of artifacts. Unset = unlimited (self-host stays open).\nOver the cap → 409.",
    example: "1000",
  },
  {
    name: "DERIVE_MAX_BYTES",
    group: "limits",
    doc: "Workspace cap on the summed byte size of all stored versions. Unset = unlimited.\nOver the cap → 413.",
    example: "1073741824",
  },

  // -- auth --
  {
    name: "DERIVE_AUTH_SECRET",
    group: "auth",
    doc: "Session-signing secret. Email + password works out of the box; set a real secret in\nproduction (also encrypts stored third-party credentials at rest).",
    example: "change-me-to-a-long-random-string",
    secret: true,
  },
  {
    name: "DERIVE_SUPERADMIN_EMAILS",
    group: "auth",
    doc: "Instance operators (super-admins): comma-separated emails that get global powers\n(cross-workspace takedown, the reports/audit queue) on top of the DERIVE_TOKEN bearer.",
    example: "you@example.com,ops@example.com",
  },
  {
    name: "DERIVE_WEB_ORIGIN",
    group: "auth",
    doc: "When the web app is served from a different origin than the API (the hosted split, or\na reverse proxy), list the web origin(s) here, comma-separated. localhost dev ports\n(3090, 5173) are trusted automatically.",
    example: "https://app.example.com",
  },
  {
    name: "DERIVE_CROSS_SITE",
    group: "auth",
    doc: "When the SPA and API are on different sites (the hosted split / a CDN front end), the\nsession cookie must be SameSite=None; Secure to ride cross-site requests. Pair with\nDERIVE_WEB_ORIGIN. Single-origin self-host leaves this off.",
    example: "true",
  },
  {
    name: "DERIVE_PASSKEY_RPID",
    group: "auth",
    doc: "Passkeys (WebAuthn) turn on wherever the relying-party ID resolves — always for a\nsingle-origin self-host. For a split SPA+API on different registrable domains, set the\nshared parent domain here to keep passkeys enabled.",
    example: "example.com",
  },

  // -- hosting isolation & custom domains --
  {
    name: "DERIVE_SANDBOX_URL",
    group: "hosting",
    doc: "Origin isolation (recommended for any instance hosting other people's HTML): serve\nartifact bytes from a SEPARATE registrable domain pointed at this same container, so\nuser HTML can never execute on the app's cookie origin. Use a different domain (not a\nsubdomain of BASE_URL). Unset = single-origin self-host (the iframe sandbox is the wall).",
    example: "https://usercontent.example.com",
  },
  {
    name: "DERIVE_SUBDOMAIN_BASE",
    group: "hosting",
    doc: "Vanity subdomains (domain mode): a base domain whose wildcard (*.<base>) points at this\nserver. An artifact assigned `q3-review.<base>` is served at that host's root. Unset =\nsubdomain serving off.",
    example: "derived.app",
  },
  {
    name: "CF_API_TOKEN",
    group: "hosting",
    doc: "Bring-your-own custom domains (Cloudflare for SaaS): let an owner attach their own\ndomain to an artifact; CF issues + renews the TLS cert. All three CF_* are required to\nenable; unset = custom domains off (subdomains unaffected). Scoped token: SSL for SaaS /\ncustom-hostname edit.",
    example: "...",
    secret: true,
  },
  {
    name: "CF_ZONE_ID",
    group: "hosting",
    doc: "The Cloudflare zone hosting your SaaS fallback origin.",
    example: "...",
  },
  {
    name: "CF_SAAS_FALLBACK_ORIGIN",
    group: "hosting",
    doc: "The CNAME target customers point their custom domain at.",
    example: "derive-saas.example.com",
  },

  // -- email --
  {
    name: "RESEND_API_KEY",
    group: "email",
    doc: "Transactional email via Resend (over fetch, no SDK). BOTH RESEND_API_KEY and EMAIL_FROM\nmust be set to actually send; with neither, Derive logs the message — including reset\nlinks — instead of sending (the zero-config default), so password reset + email\nverification stay hidden in the UI until configured. (The Cloudflare tier uses its Email\nService binding instead.)",
    example: "re_...",
    secret: true,
  },
  {
    name: "EMAIL_FROM",
    group: "email",
    doc: "The From address for transactional email.",
    example: "Derive <notifications@your-domain.com>",
  },

  // -- sign-in providers --
  {
    name: "GOOGLE_CLIENT_ID",
    group: "providers",
    doc: "Optional Google sign-in. Callback URL: <BASE_URL>/api/auth/callback/google",
    example: "",
  },
  { name: "GOOGLE_CLIENT_SECRET", group: "providers", doc: "", example: "", secret: true },
  {
    name: "GITHUB_LOGIN_CLIENT_ID",
    group: "providers",
    doc: "Optional GitHub sign-in (a standard GitHub OAuth app — distinct from the repo-sync\nGitHub App). Callback URL: <BASE_URL>/api/auth/callback/github",
    example: "",
  },
  { name: "GITHUB_LOGIN_CLIENT_SECRET", group: "providers", doc: "", example: "", secret: true },
  {
    name: "OIDC_ISSUER",
    group: "providers",
    doc: "Optional enterprise SSO via OIDC (Okta, Entra, Auth0, Keycloak, …).",
    example: "https://your-org.okta.com",
  },
  { name: "OIDC_CLIENT_ID", group: "providers", doc: "", example: "" },
  { name: "OIDC_CLIENT_SECRET", group: "providers", doc: "", example: "", secret: true },
  {
    name: "OIDC_PROVIDER_ID",
    group: "providers",
    doc: "URL-path id for the provider.",
    example: "sso",
  },
  {
    name: "OIDC_PROVIDER_LABEL",
    group: "providers",
    doc: 'Button label shown on the sign-in page for the OIDC provider. Default: "SSO".',
    example: "Acme SSO",
  },

  // -- slack --
  {
    name: "SLACK_CLIENT_ID",
    group: "slack",
    doc: "Slack app credentials — all three are required to enable the Slack integration (connect\nflow + Events API reply-back). Unset = Slack off.",
    example: "",
  },
  { name: "SLACK_CLIENT_SECRET", group: "slack", doc: "", example: "", secret: true },
  { name: "SLACK_SIGNING_SECRET", group: "slack", doc: "", example: "", secret: true },

  // -- advanced --
  {
    name: "DERIVE_DEFAULT_ORG_ID",
    group: "advanced",
    doc: "The bootstrap workspace id. Auto-generated + persisted beside the data on first run;\nset only to pin a specific id (e.g. to match an existing deployment).",
    example: "ws_...",
  },
]

// ---- Capabilities (features gated on config) ------------------------------
/**
 * A feature that turns on only when its configuration is present. `requires` are the var
 * names that must ALL be set; a nonempty-but-incomplete subset is `partial` — the silent
 * half-configuration to surface. This is the ONE gating rule: boot warnings, `derive
 * doctor`, and /v1/auth/capabilities all read it (none re-derive from env).
 */
export interface Capability {
  id: string
  label: string
  requires: string[]
  detail: string
}

export const CAPABILITIES: Capability[] = [
  {
    id: "email",
    label: "Transactional email",
    requires: ["RESEND_API_KEY", "EMAIL_FROM"],
    detail:
      "Password reset, email verification, and invite emails. With both set, Derive sends via Resend; with neither, it logs messages instead. The Cloudflare tier uses its Email Service binding.",
  },
  {
    id: "google",
    label: "Google sign-in",
    requires: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    detail: "Adds a Continue-with-Google button. Callback: <BASE_URL>/api/auth/callback/google.",
  },
  {
    id: "github",
    label: "GitHub sign-in",
    requires: ["GITHUB_LOGIN_CLIENT_ID", "GITHUB_LOGIN_CLIENT_SECRET"],
    detail:
      "Adds a Continue-with-GitHub button (distinct from the repo-sync GitHub App). Callback: <BASE_URL>/api/auth/callback/github.",
  },
  {
    id: "oidc",
    label: "Enterprise SSO (OIDC)",
    requires: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
    detail: "Enterprise single sign-on via OIDC (Okta, Entra, Auth0, Keycloak).",
  },
  {
    id: "slack",
    label: "Slack integration",
    requires: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
    detail: "Slack connect flow plus Events API reply-back.",
  },
  {
    id: "customDomains",
    label: "Custom domains (Cloudflare for SaaS)",
    requires: ["CF_API_TOKEN", "CF_ZONE_ID", "CF_SAAS_FALLBACK_ORIGIN"],
    detail:
      "Lets an owner attach their own domain to an artifact; Cloudflare for SaaS issues the TLS certificate.",
  },
]

// ---- Derivations ----------------------------------------------------------
export type CapabilityStatus = "on" | "off" | "partial"

const isSet = (env: Env, key: string): boolean => {
  const v = env[key]
  return typeof v === "string" && v.trim() !== ""
}

export const statusOf = (cap: Capability, env: Env): CapabilityStatus => {
  const present = cap.requires.filter((k) => isSet(env, k)).length
  if (present === cap.requires.length) return "on"
  if (present === 0) return "off"
  return "partial"
}

/** Whether a capability is fully configured — the one gating check every surface uses. */
export const isCapabilityOn = (id: string, env: Env): boolean => {
  const cap = CAPABILITIES.find((c) => c.id === id)
  return cap ? statusOf(cap, env) === "on" : false
}

export interface CapabilityState {
  id: string
  label: string
  status: CapabilityStatus
  detail: string
  missing: string[]
}

export const capabilityReport = (env: Env): CapabilityState[] =>
  CAPABILITIES.map((cap) => ({
    id: cap.id,
    label: cap.label,
    status: statusOf(cap, env),
    detail: cap.detail,
    missing: cap.requires.filter((k) => !isSet(env, k)),
  }))

/**
 * Boot-time warnings for half-configured features: a nonempty-but-incomplete required set
 * means the feature is silently OFF — almost always a mistake. The caller logs these; this
 * never throws, so a stray env var can't take down a running instance.
 */
export const configWarnings = (env: Env): string[] =>
  CAPABILITIES.filter((cap) => statusOf(cap, env) === "partial").map((cap) => {
    const have = cap.requires.filter((k) => isSet(env, k))
    const missing = cap.requires.filter((k) => !isSet(env, k))
    return `${cap.label} is half-configured — ${have.join(", ")} set but ${missing.join(", ")} missing, so it stays OFF. Set ${missing.join(", ")}, or unset ${have.join(", ")}.`
  })

// ---- .env.example generation ----------------------------------------------
const HEADER =
  "# Derive — every variable is optional; defaults shown. Nothing crashes on missing config.\n" +
  "# GENERATED from apps/api/src/config-manifest.ts; do not edit by hand. Regenerate after a\n" +
  "# change: `pnpm --filter @derive/api gen:env`."

const banner = (title: string): string => {
  const line = `# --- ${title} `
  return line + "-".repeat(Math.max(3, 76 - line.length))
}

const comment = (text: string): string =>
  text
    .split("\n")
    .map((l) => (l ? `# ${l}` : "#"))
    .join("\n")

/** Render the canonical `.env.example` from CONFIG_VARS + GROUPS. */
export const genEnvExample = (): string => {
  const out: string[] = [HEADER]
  for (const group of GROUPS) {
    const vars = CONFIG_VARS.filter((v) => v.group === group.id)
    if (!vars.length) continue
    const block: string[] = []
    if (group.title) block.push(banner(group.title))
    for (const v of vars) {
      const lines: string[] = []
      if (v.doc) lines.push(comment(v.doc))
      const assign = `${v.name}=${v.example ?? ""}`
      lines.push(v.active ? assign : `# ${assign}`)
      block.push(lines.join("\n"))
    }
    if (group.note) block.push(comment(group.note))
    out.push(block.join("\n\n"))
  }
  return `${out.join("\n\n")}\n`
}
