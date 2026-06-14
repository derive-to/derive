import { type BetterAuthOptions, betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { genericOAuth } from "better-auth/plugins"

const env = (k: string) => process.env[k]

/** Whatever Better Auth accepts as its datastore: a better-sqlite3 / pg handle on
 *  Node, or a Kysely dialect config (`{ dialect, type }`) on the edge (D1). */
export type AuthDb = BetterAuthOptions["database"]

/**
 * Better Auth: email+password out of the box; Google when its env is set; and
 * an enterprise OIDC provider (Okta/Entra/etc.) via the generic-OAuth plugin
 * when OIDC_* is set. Owns its own user/session/account tables.
 */
export function makeAuth(db: AuthDb, baseUrl: string, secret: string) {
  // The browser sends its own Origin (the web app), which differs from the API's
  // baseURL whenever the SPA and API are on separate origins (dev proxy, or the
  // hosted split of static-web + API container). DOCK_WEB_ORIGIN lists those in
  // production; localhost dev ports are trusted automatically.
  const webOrigins = (env("DOCK_WEB_ORIGIN") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const devOrigins = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(baseUrl)
    ? ["http://localhost:3000", "http://localhost:5173"]
    : []
  const staticTrusted = [...new Set([baseUrl, ...webOrigins, ...devOrigins])]

  // Also trust a request whose Origin equals the origin it was actually served on
  // (its own Host). A same-origin request is never CSRF, so this is safe: a
  // cross-site attacker's Origin can never equal the victim browser's Host. It
  // rescues the common self-host footgun: a port-mapped container or reverse proxy
  // reached at an origin that doesn't exactly match BASE_URL (e.g. BASE_URL inferred
  // as :8080 but the host published :8081) would otherwise 403 INVALID_ORIGIN on
  // signup/login. Cross-origin (the real CSRF case) still requires an explicit
  // baseUrl / DOCK_WEB_ORIGIN entry. A TLS-terminating proxy (browser https, app
  // http) won't match here, so set BASE_URL to the public https origin for those.
  const trusted = async (request?: Request): Promise<string[]> => {
    try {
      const origin = request?.headers.get("origin")
      if (origin && request && origin === new URL(request.url).origin)
        return [...staticTrusted, origin]
    } catch {}
    return staticTrusted
  }

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}
  const googleId = env("GOOGLE_CLIENT_ID")
  const googleSecret = env("GOOGLE_CLIENT_SECRET")
  if (googleId && googleSecret)
    socialProviders.google = { clientId: googleId, clientSecret: googleSecret }

  const oidc: {
    providerId: string
    discoveryUrl: string
    clientId: string
    clientSecret: string
    scopes: string[]
  }[] = []
  const oidcIssuer = env("OIDC_ISSUER")
  const oidcId = env("OIDC_CLIENT_ID")
  const oidcSecret = env("OIDC_CLIENT_SECRET")
  if (oidcIssuer && oidcId && oidcSecret)
    oidc.push({
      providerId: env("OIDC_PROVIDER_ID") ?? "sso",
      discoveryUrl: `${oidcIssuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      clientId: oidcId,
      clientSecret: oidcSecret,
      scopes: ["openid", "email", "profile"],
    })

  // When the SPA and API are on different sites (CDN web + container API), the
  // session cookie must be SameSite=None; Secure to ride cross-site fetches.
  const crossSite = env("DOCK_CROSS_SITE") === "true" || env("DOCK_CROSS_SITE") === "1"

  return betterAuth({
    database: db,
    baseURL: baseUrl,
    secret,
    emailAndPassword: { enabled: true },
    socialProviders,
    trustedOrigins: trusted,
    plugins: oidc.length ? [genericOAuth({ config: oidc })] : [],
    advanced: {
      // Keep the CSRF origin check on in every environment. Better Auth silently
      // disables it when NODE_ENV=test; pinning it false means a server mistakenly
      // booted with NODE_ENV=test still validates Origin (and lets the suite test it).
      disableOriginCheck: false,
      ...(crossSite
        ? { defaultCookieAttributes: { sameSite: "none" as const, secure: true } }
        : {}),
    },
  })
}

export type Auth = ReturnType<typeof makeAuth>

export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
}
