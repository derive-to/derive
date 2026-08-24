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
  /** A trailing note for the generated section. */
  note?: string
}

const GROUPS: Group[] = [
  { id: "core", title: undefined },
  { id: "limits", title: "Analytics, limits & quotas" },
  { id: "auth", title: "Auth (Better Auth)" },
  { id: "hosting", title: "Origin isolation & custom domains" },
  { id: "email", title: "Email (verification, password reset, invites)" },
  {
    id: "providers",
    title: "Sign-in providers (OAuth / SSO)",
    note: "The GitHub integration is created from Settings → Integrations and stores its\nApp credentials encrypted with DERIVE_AUTH_SECRET. It does not use these sign-in vars.",
  },
  { id: "slack", title: "Slack (connect + reply-back)" },
  { id: "search", title: "Semantic search (pgvector)" },
  { id: "billing", title: "Billing (Stripe)" },
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
}

const CONFIG_VARS: ConfigVar[] = [
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
  },
  {
    name: "DATABASE_URL",
    group: "core",
    doc: "Optional Postgres for metadata instead of the default embedded SQLite.",
    example: "postgres://user:pass@host:5432/derive",
  },
  {
    name: "DERIVE_ALLOW_REMOTE_DB",
    group: "core",
    doc: "Safety gate: pointing DATABASE_URL at a REMOTE host during local `pnpm dev` is blocked\nby default, so a dev machine can't accidentally mutate a production database. Set to 1\nto allow a remote DB in dev. No effect in production.",
    example: "1",
  },
  {
    name: "DERIVE_BUILD_SHA",
    group: "core",
    doc: 'The commit this build was cut from. /healthz echoes it as `build`, so "which version is\nactually running" is answerable with curl rather than inferred from a deploy log — a deploy\ncan fail while the pipeline around it reads green, and liveness alone cannot tell a fresh\nprocess from the one already serving. Unset reports "dev". Set it in your image build.',
    example: "",
  },
  {
    name: "DERIVE_TOKEN",
    group: "core",
    doc: "A static bearer token for headless CI/agent writes (and reading gated artifacts).\nSigned-in users can always write; anonymous callers are read-only either way.",
    example: "",
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
  },
  {
    name: "DERIVE_SUPERADMIN_EMAILS",
    group: "auth",
    doc: "Deprecated migration only: matching verified legacy accounts are bound once to\nimmutable user-id operator records. This list never admits account creation.",
    example: "you@example.com,ops@example.com",
  },
  {
    name: "DERIVE_SIGNUP_MODE",
    group: "auth",
    doc: "Account admission: open (anyone), invite (requires a live invitation capability),\nor closed (offline bootstrap only). Existing users can always sign in.",
    example: "invite",
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
    name: "DERIVE_SITE_ORIGIN",
    group: "hosting",
    doc: "Origin of the public site (marketing pages, blog) for a HOSTED deployment on the\nNode tier: navigations the app does not own are proxied there, and `/` serves its\nlanding page to signed-out visitors. derive.to itself runs on Workers and binds the\nsite Worker directly (wrangler.toml [[services]] SITE). Unset = the application owns\nthe front door, which is right for every self-host.",
    example: "http://localhost:4321",
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
  { name: "GOOGLE_CLIENT_SECRET", group: "providers", doc: "", example: "" },
  {
    name: "GITHUB_LOGIN_CLIENT_ID",
    group: "providers",
    doc: "Optional GitHub sign-in (distinct from the GitHub integration App). Callback URL:\n<BASE_URL>/api/auth/callback/github",
    example: "",
  },
  { name: "GITHUB_LOGIN_CLIENT_SECRET", group: "providers", doc: "", example: "" },
  {
    name: "OIDC_ISSUER",
    group: "providers",
    doc: "Optional enterprise SSO via OIDC (Okta, Entra, Auth0, Keycloak, …).",
    example: "https://your-org.okta.com",
  },
  { name: "OIDC_CLIENT_ID", group: "providers", doc: "", example: "" },
  { name: "OIDC_CLIENT_SECRET", group: "providers", doc: "", example: "" },
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
  { name: "SLACK_CLIENT_SECRET", group: "slack", doc: "", example: "" },
  { name: "SLACK_SIGNING_SECRET", group: "slack", doc: "", example: "" },

  // -- search --
  {
    name: "DERIVE_EMBED_PROVIDER",
    group: "search",
    doc: "Turn on dense/semantic search (pgvector) and pick the embedder. `local` runs an in-process\nONNX model (bge-small, no credentials, downloads ~30 MB on first boot) — the zero-config\nchoice. `workersai` calls Cloudflare Workers AI (bge-m3) over REST, which needs\nDERIVE_EMBED_CF_ACCOUNT_ID + DERIVE_EMBED_CF_API_TOKEN below. Either way requires\nDATABASE_URL (Postgres — pgvector lives there); with embedded SQLite it's skipped. Unset =\nlexical-only search. The Cloudflare edge tier uses its Workers AI binding instead of this.",
    example: "local",
  },
  { name: "DERIVE_EMBED_CF_ACCOUNT_ID", group: "search", doc: "", example: "" },
  { name: "DERIVE_EMBED_CF_API_TOKEN", group: "search", doc: "", example: "" },

  // -- billing --
  {
    name: "STRIPE_SECRET_KEY",
    group: "billing",
    doc: "Stripe secret key (sk_test_/sk_live_). Unset disables the billing routes\nentirely; self-host never needs it.",
    example: "",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    group: "billing",
    doc: "Signing secret for the Stripe webhook endpoint (whsec_...). Required for\n/v1/billing/webhook to accept events.",
    example: "",
  },
  {
    name: "DERIVE_BILLING_ENFORCE_AT",
    group: "billing",
    doc: "ISO instant after which free-tier boundaries enforce (3 editor seats, 1 GB).\nUnset = beta grace: nothing is blocked and white-label stays free.",
    example: "2026-09-01T00:00:00Z",
  },

  // -- advanced --
  {
    name: "DERIVE_DEFAULT_ORG_ID",
    group: "advanced",
    doc: "The bootstrap workspace id. Auto-generated + persisted beside the data on first run;\nset only to pin a specific id (e.g. to match an existing deployment).",
    example: "ws_...",
  },
  {
    name: "DERIVE_BACKGROUND_WORKERS",
    group: "advanced",
    doc: "Set to 0 to stop this process running shared background work: webhook delivery,\nthe daily prune, and the expired-draft sweep. They are ON by default and a deployment\nshould leave them on. This exists for one case — pointing a local process at a REMOTE\ndatabase to reproduce something. Those workers WRITE (the prune and sweep delete rows,\nand the prune fires on boot), so without this a laptop joins that database's worker pool\nthe moment it starts.",
    example: "0",
  },
  {
    name: "DERIVE_PREVIEWS",
    group: "advanced",
    doc: "Render artifact preview screenshots on this Node deploy (needs a Playwright Chromium —\nbundled in the Docker image; on a bare Node host run\n`pnpm --filter @derive/api exec playwright install chromium`). Unset = previews off.",
    example: "true",
  },
  {
    name: "DERIVE_HOSTED_RUNS",
    group: "advanced",
    doc: "EXPERIMENTAL — hosted automation runs on this Node deploy: the API process materializes\ndue schedules and executes each run by spawning the derive CLI\n(`derive runner run <capability token>`) as a child process on this box. Needs the CLI,\nthe selected coding agent (Claude Code or Codex), and a matching connected model plan.\nAmbient model keys are deliberately not inherited by the child. Unset = off; queued runs\nthen wait for a polling `derive runner`.",
    example: "true",
  },
  {
    name: "DERIVE_HOSTED_RUNS_ALLOWLIST",
    group: "advanced",
    doc: "Comma-separated immutable workspace ids allowed to execute on this deployment's\nhosted substrate. It gates scheduled materialization, stale-run recovery, the minute dispatch\nsweep, Run now nudges, and hosted ask sessions. Owner-operated polling runners are unaffected.\n\nOn the multi-tenant Cloudflare Worker, unset or blank means NOBODY (fail closed). On a Node\nself-host, unset preserves the single-tenant default of no restriction; set it to restrict\nhosted execution there too, and set it to an empty string for a deployment-level stop.",
    example: "ws_abc123,ws_def456",
  },
  {
    name: "DERIVE_LOOP_RUNS",
    group: "advanced",
    doc: 'EXPERIMENTAL — run hosted automations IN THIS PROCESS instead of spawning the derive CLI.\nA model call plus fetch, which is all a "read something, write an artifact" automation\nneeds, with no child process and no container. Anything wanting a shell, a filesystem or\ngit still belongs on the CLI runner, so this is opt-in and DERIVE_HOSTED_RUNS must also be\non. The same code path runs on Cloudflare: the loop is an HTTP client of this API, so\nthere is no platform-specific implementation to keep in step.',
    example: "1",
  },
  {
    name: "DERIVE_LOOP_MODEL",
    group: "advanced",
    doc: "ANTHROPIC model id for in-process runs (DERIVE_LOOP_RUNS) that resolve a per-run model\nplan through the payer chain. Unset = claude-sonnet-5, which is the right default for\nautomations: they are latency- and tool-call-bound, so depth buys less than turnaround.\n\nThis is NOT DERIVE_MODEL_NAME. That one names the model on your OpenAI-compatible\ngateway and is only meaningful alongside DERIVE_MODEL_BASE_URL; sending it to\napi.anthropic.com returns `model_not_found` on every run. They are separate vars because\nthe two ids look interchangeable and are not — passing the gateway's id on the\ncredential path is what broke every hosted run before this existed.",
    example: "claude-sonnet-5",
  },
  {
    name: "DERIVE_MODEL_BASE_URL",
    group: "advanced",
    doc: "Root of an OPENAI-COMPATIBLE model endpoint (Fireworks, OpenRouter, Together, a\nself-hosted gateway); `/chat/completions` is appended. Setting it points every in-process\nrun AND attended chat on this deploy at that endpoint instead of the Anthropic Messages API.\n\nIt BYPASSES THE PAYER CHAIN on purpose: this deployment holds the key and spends it for\nevery workspace on it, so there is no chain to walk and no plan for anyone to connect.\nThat is the HOSTED posture — derive.to sets all three — and the workspace is metered\nagainst its tier allowance rather than billed to a credential it never supplied. It is\nequally right for a single-tenant box, where the operator is the only user.\n\n(This entry used to say derive.to does not set it. That was wrong, and it was read as\nintent: the schedule materializer kept walking a payer chain that cannot resolve on a\nhosted deploy, so scheduled automations silently never fired.)\n\nRequires DERIVE_MODEL_API_KEY and DERIVE_MODEL_NAME; all three or none.",
    example: "https://api.fireworks.ai/inference/v1",
  },
  {
    name: "DERIVE_MODEL_API_KEY",
    group: "advanced",
    doc: "Bearer token for DERIVE_MODEL_BASE_URL. Read by the API process only and never forwarded\ninto a CLI runner's environment, so it cannot redirect a coding agent's credentials.",
    example: "sk-...",
  },
  {
    name: "DERIVE_CHAT_ALLOWLIST",
    group: "advanced",
    doc: "Comma-separated workspace ids allowed to turn chat on, when DERIVE_MODEL_BASE_URL is set.\n\nWhy it exists: `chatBeta` is a workspace setting, gated on `manage` — so on a MULTI-TENANT\nhost any workspace owner could enable chat for themselves and spend the operator's model\nkey. On a single-tenant box that is fine (the operator IS the user), which is why an unset\nallowlist means no restriction. Set it on a shared host and only those workspaces can\nenable chat, however many owners ask.",
    example: "ws_abc123,ws_def456",
  },
  {
    name: "DERIVE_MODEL_NAME",
    group: "advanced",
    doc: "Model id to send to DERIVE_MODEL_BASE_URL, exactly as that provider names it.",
    example: "accounts/fireworks/models/deepseek-v4-flash",
  },
  {
    name: "DERIVE_MODEL_NAMES",
    group: "advanced",
    doc: 'Comma-separated ADDITIONAL model ids the same DERIVE_MODEL_BASE_URL serves, offered to\nchat as a choice alongside DERIVE_MODEL_NAME (which stays the default and is always\navailable whether or not it is repeated here).\n\nOne gateway serving many models is how every host this reaches works (Fireworks,\nOpenRouter, Together, vLLM), so a second model needs no second key and no second secret\nto rotate. Unset = one model, exactly as before, and the chat picker does not render.\n\nIds are the provider\'s own, stored on each answer, so a person can see which model wrote\nwhat. Removing an id here does not rewrite history: a conversation that used it is told\nthe model is gone rather than silently answered by a different one.\n\nTHIS IS THE FLOOR, NOT THE WHOLE LIST. An instance operator adds models, renames them,\npins chat or automations to one, and probes any of them from Settings -> Instance ->\nModels, with no redeploy — same gateway, same key, so a model there is data. Set here\nonly what every deployment of this configuration should start with. A genuinely\ndifferent provider needs a key, which only the environment can hold, so that stays a\ndeploy. See apps/docs/content/self-hosting/configuration.md, "The model library".',
    example: "accounts/fireworks/models/qwen3-235b,accounts/fireworks/models/kimi-k2",
  },
  {
    name: "DERIVE_MODEL_PROVIDERS",
    group: "advanced",
    doc: "Preferred upstream backends, best first, comma-separated. Only meaningful on a gateway\nthat routes one model id to several of them; unset = the gateway routes as it likes.",
    example: "provider-a,provider-b",
  },
  {
    name: "DERIVE_LOCAL_BROKER",
    group: "advanced",
    doc: "DEV ONLY — let a workspace with no broker plan use the ECHO stub instead of a broker that\nrefuses. The stub's `execute` returns the caller's own arguments: it reaches Stripe, Gmail\nand nothing else, so a run using it reports success over data that never existed and writes\nan artifact full of invented numbers, with no error anywhere. Unset = a workspace with no\nplan gets a refusing broker, which is what you want everywhere a human might see the output.\nMCP connections are unaffected either way — they carry their own server and route on their\nown ref.",
    example: "1",
  },
  {
    name: "DERIVE_RUNNER_BIN",
    group: "advanced",
    doc: "Path to the derive CLI the hosted-runs worker spawns (read only when\nDERIVE_HOSTED_RUNS is on). Unset = `derive` on PATH.",
    example: "/usr/local/bin/derive",
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
      "Adds a Continue-with-GitHub button (distinct from the GitHub integration App). Callback: <BASE_URL>/api/auth/callback/github.",
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
  {
    id: "semanticSearch",
    label: "Semantic search (pgvector)",
    requires: ["DERIVE_EMBED_PROVIDER"],
    detail:
      "Dense/semantic workspace search: embeddings (a local ONNX model, or Cloudflare Workers AI over REST) stored in pgvector in your Postgres and fused with lexical FTS. Set DERIVE_EMBED_PROVIDER=local|workersai. Also requires DATABASE_URL (Postgres) — with embedded SQLite it stays lexical-only, so the reported status reflects the running datastore.",
  },
  {
    id: "hostedRuns",
    label: "Hosted automation runs (experimental)",
    requires: ["DERIVE_HOSTED_RUNS"],
    detail:
      "EXPERIMENTAL. This process executes due automation runs itself — materializing schedules, reclaiming runs whose executor died, and spawning `derive runner run` per run — so an automation updates its artifact with no polling runner and no extra machine. Needs the derive CLI plus a coding agent (claude/codex) installed, and a connected model plan (or an ambient ANTHROPIC_API_KEY / OPENAI_API_KEY) for whoever the run bills. Off ⇒ runs stay queued for a polling `derive runner`.",
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
