import Database from "better-sqlite3"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { genericOAuth } from "better-auth/plugins"

const env = (k: string) => process.env[k]

/**
 * Better Auth: email+password out of the box; Google when its env is set; and
 * an enterprise OIDC provider (Okta/Entra/etc.) via the generic-OAuth plugin
 * when OIDC_* is set. Owns its own user/session/account tables.
 */
export function makeAuth(db: Database.Database, baseUrl: string) {
  // The browser sends its own Origin (the web app), which differs from the API's
  // baseURL whenever the SPA and API are on separate origins (dev proxy, or the
  // hosted split of static-web + API container). DOCK_WEB_ORIGIN lists those in
  // production; localhost dev ports are trusted automatically.
  const webOrigins = (env("DOCK_WEB_ORIGIN") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const devOrigins = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(baseUrl)
    ? ["http://localhost:3000", "http://localhost:5173"]
    : []
  const trusted = [...new Set([baseUrl, ...webOrigins, ...devOrigins])]

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}
  if (env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"))
    socialProviders.google = {
      clientId: env("GOOGLE_CLIENT_ID")!,
      clientSecret: env("GOOGLE_CLIENT_SECRET")!,
    }

  const oidc: {
    providerId: string
    discoveryUrl: string
    clientId: string
    clientSecret: string
    scopes: string[]
  }[] = []
  if (env("OIDC_ISSUER") && env("OIDC_CLIENT_ID") && env("OIDC_CLIENT_SECRET"))
    oidc.push({
      providerId: env("OIDC_PROVIDER_ID") ?? "sso",
      discoveryUrl: `${env("OIDC_ISSUER")!.replace(/\/$/, "")}/.well-known/openid-configuration`,
      clientId: env("OIDC_CLIENT_ID")!,
      clientSecret: env("OIDC_CLIENT_SECRET")!,
      scopes: ["openid", "email", "profile"],
    })

  // When the SPA and API are on different sites (CDN web + container API), the
  // session cookie must be SameSite=None; Secure to ride cross-site fetches.
  const crossSite = env("DOCK_CROSS_SITE") === "true" || env("DOCK_CROSS_SITE") === "1"

  return betterAuth({
    database: db,
    baseURL: baseUrl,
    secret: env("DOCK_AUTH_SECRET") ?? "dock-dev-insecure-secret-change-me-please-32",
    emailAndPassword: { enabled: true },
    socialProviders,
    trustedOrigins: trusted,
    plugins: oidc.length ? [genericOAuth({ config: oidc })] : [],
    ...(crossSite
      ? { advanced: { defaultCookieAttributes: { sameSite: "none" as const, secure: true } } }
      : {}),
  })
}

export type Auth = ReturnType<typeof makeAuth>

export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
}
