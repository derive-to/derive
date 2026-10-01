// Runtime-neutral env parsing shared by the Node (config.ts) and Cloudflare Worker
// (worker.ts) entries. config.ts itself can't be imported on the edge — it pulls in
// node:crypto/fs/path — but these three transforms need no Node builtins, so they live
// here where both entries can reach them (the same pattern as customDomainsFromEnv).

/** Comma-separated operator (super-admin) emails → a lowercased, de-blanked list. */
export const superAdminsFromEnv = (env: { DERIVE_SUPERADMIN_EMAILS?: string }): string[] =>
  (env.DERIVE_SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

/** A comma-separated set of immutable workspace ids. An absent value and an explicitly empty
 *  value both parse to an empty set; callers decide whether absence means unrestricted (Node
 *  self-host) or fail-closed (the multi-tenant edge). */
export const workspaceIdsFromEnv = (raw: string | undefined): ReadonlySet<string> =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )

/** The Derive-machine (Ortam) runtime config, or undefined when no runner path is set. One
 *  builder for the Node entry and both Worker uses (the app and the scheduled tick). */
export const ortamRuntimeFromEnv = (env: {
  DERIVE_ORTAM_RUNNER_PATH?: string
  DERIVE_ORTAM_API_URL?: string
  DERIVE_ORTAM_INTEGRATION_KEY?: string
  DERIVE_MANAGED_RUNS_ALLOWLIST?: string
}) =>
  env.DERIVE_ORTAM_RUNNER_PATH
    ? {
        runnerPath: env.DERIVE_ORTAM_RUNNER_PATH,
        apiUrl: env.DERIVE_ORTAM_API_URL ?? "https://api.ortam.dev/v1",
        managed: env.DERIVE_ORTAM_INTEGRATION_KEY
          ? {
              apiKey: env.DERIVE_ORTAM_INTEGRATION_KEY,
              workspaceIds: workspaceIdsFromEnv(env.DERIVE_MANAGED_RUNS_ALLOWLIST),
            }
          : undefined,
      }
    : undefined

/** The Slack App credentials — only when all three are set (else Slack stays off). */
export const slackFromEnv = (env: {
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_SIGNING_SECRET?: string
}): { clientId: string; clientSecret: string; signingSecret: string } | undefined =>
  env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET
    ? {
        clientId: env.SLACK_CLIENT_ID,
        clientSecret: env.SLACK_CLIENT_SECRET,
        signingSecret: env.SLACK_SIGNING_SECRET,
      }
    : undefined

/** The vanity-subdomain base host, lowercased with leading/trailing dots stripped. */
export const subdomainBaseFromEnv = (env: { DERIVE_SUBDOMAIN_BASE?: string }): string | undefined =>
  env.DERIVE_SUBDOMAIN_BASE?.toLowerCase().replace(/^\.+|\.+$/g, "") || undefined
