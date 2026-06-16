import { oauthProvider } from "@better-auth/oauth-provider"
import { generateUsername } from "@dock/core"
import { type BetterAuthOptions, betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { genericOAuth, jwt } from "better-auth/plugins"
import { sha256 } from "./lib/crypto"

// Scopes an agent can be granted via the OAuth consent. The dock:* scopes map to
// what the issued token may do; openid/profile/email/offline_access are the
// standard OIDC set the flow needs. Least-privilege default is propose+comment+read.
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "dock:read",
  "dock:comment",
  "dock:propose",
  "dock:publish",
  "dock:review",
] as const

const env = (k: string) => process.env[k]

/** Whatever Better Auth accepts as its datastore: a better-sqlite3 / pg handle on
 *  Node, or a Kysely dialect config (`{ dialect, type }`) on the edge (D1). */
export type AuthDb = BetterAuthOptions["database"]

/**
 * Better Auth: email+password out of the box; Google when its env is set; and
 * an enterprise OIDC provider (Okta/Entra/etc.) via the generic-OAuth plugin
 * when OIDC_* is set. Owns its own user/session/account tables.
 */
/** Optional integrations the auth layer needs from the surrounding app. */
export interface AuthHooks {
  /** Is this handle already taken? Lets the auto-assign hook pick a free one.
   *  Omitted in schema-gen / tests (no real user table); the unique index backstops. */
  usernameTaken?: (username: string) => Promise<boolean>
}

export function makeAuth(db: AuthDb, baseUrl: string, secret: string, hooks: AuthHooks = {}) {
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

  // RFC 8707 resource indicators an MCP client binds its token to. The spec requires
  // the client to send `resource` at authorize + token, and the oauth-provider 400s
  // ("requested resource invalid") unless that value is an accepted audience — its
  // default is only the auth server's own base URL. MCP clients send the SERVER
  // (Claude Code sends the origin with a trailing slash; others may send the /mcp
  // endpoint), so accept the origin and /mcp in both slash forms.
  const origin = (() => {
    try {
      return new URL(baseUrl).origin
    } catch {
      return baseUrl.replace(/\/+$/, "")
    }
  })()
  // A superset of the plugin's default ([baseUrl]) so no previously-valid audience
  // is narrowed; resource validation only runs at all when a client sends `resource`
  // (MCP clients do; dock login and the browser consent flow don't), so other flows
  // are untouched.
  const mcpAudiences = [
    ...new Set([baseUrl, origin, `${origin}/`, `${origin}/mcp`, `${origin}/mcp/`]),
  ]

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
    // Every account gets a handle the moment it's created — so the app can identify
    // people by @handle everywhere and never has to fall back to exposing an email.
    // Auto-assigned from the email/name (the user can change it later); it never
    // overrides a handle that's somehow already set. Wrapped so a generation hiccup
    // can never block account creation (the unique index is the final backstop).
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const u = user as typeof user & { username?: string | null; email?: string }
            if (u.username) return { data: user }
            try {
              const taken = hooks.usernameTaken ?? (async () => false)
              const username = await generateUsername(u.email ?? u.name ?? "user", taken)
              return { data: { ...user, username } }
            } catch {
              return { data: user }
            }
          },
        },
      },
    },
    user: {
      additionalFields: {
        // The public handle (Profiles & Accounts v1). Claimed at onboarding via
        // POST /v1/me/username, so it's server-controlled and never accepted
        // straight from a sign-up payload (input:false). Unique so two accounts
        // can't share one; nullable until claimed. Better Auth's migration adds
        // the column + unique index, and getSession returns it on the user.
        username: { type: "string", required: false, unique: true, input: false },
        // Discoverability: when true, the account shows up in people search
        // (GET /v1/users/search). ON by default (GitHub-style — a claimed handle is
        // findable); opt out via POST /v1/me/discoverable. Search treats unset/null
        // as discoverable too, so accounts from before this column are findable
        // without a backfill. input:false, server-set only.
        discoverable: { type: "boolean", required: false, defaultValue: true, input: false },
        // Who you are on the team: a coarse role (Product / Engineering / Design /
        // Marketing / Other, free string) and a one-line "what you do" blurb. Set at
        // onboarding and editable in Settings → Profile; shown on your public profile,
        // the @mention/member directory, and fed into agent context. input:false,
        // server-set via POST /v1/me/profile. Better Auth's migration adds the columns.
        profession: { type: "string", required: false, input: false },
        about: { type: "string", required: false, input: false },
      },
    },
    socialProviders,
    trustedOrigins: trusted,
    plugins: [
      ...(oidc.length ? [genericOAuth({ config: oidc })] : []),
      // oauthProvider signs id tokens + serves JWKS through the jwt plugin.
      jwt(),
      // Dock as an OAuth 2.1 authorization server: agents (MCP clients) authenticate
      // via a browser consent instead of a pasted token, and get a scoped, expiring
      // access token. Endpoints land under /api/auth/oauth2/*; the consent screen is
      // a route we own (/oauth/consent). Tokens are opaque and stored hashed with
      // Dock's own sha256, so the bridge can resolve them by hash (see context.ts).
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        requirePKCE: true,
        allowDynamicClientRegistration: true,
        // Anonymous DCR: a headless MCP client self-registers (RFC 7591) before any
        // user has logged in, then the user authorizes in the browser. The /register
        // endpoint is rate-limited (/api/auth/*) and a client is inert until a human
        // consents, so the only surface is spam client rows.
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 60 * 60, // 1h
        refreshTokenExpiresIn: 60 * 60 * 24 * 7, // 7d
        scopes: [...OAUTH_SCOPES],
        // Accept the resource indicators MCP clients send (else token exchange 400s).
        validAudiences: mcpAudiences,
        storeTokens: { hash: async (token) => sha256(token) },
      }),
    ],
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
