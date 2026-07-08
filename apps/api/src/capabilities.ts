// Capability model: a feature that turns on only when its configuration is present.
// One source of truth for (1) the boot-time "you half-configured X" warnings (node.ts),
// (2) the `derive doctor` report, and (3) — later — the /v1/auth/capabilities endpoint,
// which today re-reads the same OAuth env separately and can drift from this. Pure and
// edge-safe (no Node builtins) so any runtime can use it.

export type CapabilityStatus = "on" | "off" | "partial"

/**
 * A feature gated on configuration. `requires` are the env vars that must ALL be present
 * for it to turn on; a nonempty-but-incomplete subset is `partial` — the silent
 * half-configuration we want to surface (e.g. an OAuth id set without its secret).
 */
export interface Capability {
  id: string
  label: string
  requires: string[]
  /** What it enables and the effect of leaving it off — for `derive doctor` + docs. */
  detail: string
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "email",
    label: "Transactional email",
    requires: ["RESEND_API_KEY", "EMAIL_FROM"],
    detail:
      "Password reset, email verification, and invite emails. With both set, Derive sends via Resend; with neither, it logs messages instead and the self-serve mail flows stay hidden in the UI. The Cloudflare tier uses its Email Service binding.",
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

export type Env = Record<string, string | undefined>

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

export interface CapabilityState {
  id: string
  label: string
  status: CapabilityStatus
  detail: string
  /** For a partial capability: the required vars still missing. */
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
 * Boot-time warnings for half-configured features: a nonempty-but-incomplete set of
 * required vars means the feature is silently OFF — almost always a mistake. The caller
 * logs these; this never throws, so a stray env var can't take down a running instance.
 */
export const configWarnings = (env: Env): string[] =>
  CAPABILITIES.filter((cap) => statusOf(cap, env) === "partial").map((cap) => {
    const have = cap.requires.filter((k) => isSet(env, k))
    const missing = cap.requires.filter((k) => !isSet(env, k))
    return `${cap.label} is half-configured — ${have.join(", ")} set but ${missing.join(", ")} missing, so it stays OFF. Set ${missing.join(", ")}, or unset ${have.join(", ")}.`
  })
