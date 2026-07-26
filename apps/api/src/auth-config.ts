import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { generateUsername } from "@derive/core"
import { type BetterAuthOptions, betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { getMigrations } from "better-auth/db/migration"
import { genericOAuth, jwt, twoFactor } from "better-auth/plugins"
import { isBreachedPassword, sha256 } from "./lib/crypto"
import { log } from "./log"

// ---- Passkey (WebAuthn) rpID/origin resolution ----------------------------
// A passkey is bound to an rpID (a registrable domain) and the ceremony's origin is
// validated. Same-origin self-host: rpID + origin are just the one host — zero config.
// Hosted split (SPA ≠ API): the ceremony runs on the SPA origin but Better Auth runs on
// the API, so we ALLOW BOTH origins and pin rpID to the registrable parent they share.
// If they share no parent (two different registrable domains), WebAuthn can't bridge them
// and passkeys are disabled (capabilities reports passkey:false). DERIVE_PASSKEY_RPID
// overrides the inference (e.g. an unusual public suffix the naive heuristic misjudges).
export interface PasskeyConfig {
  enabled: boolean
  rpID?: string
  origin: string[]
}
const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return null
  }
}
const originOf = (u: string): string => {
  try {
    return new URL(u).origin
  } catch {
    return u.replace(/\/+$/, "")
  }
}
// Longest shared dotted-label suffix of a set of hosts, requiring ≥2 labels — a naive
// eTLD+1 heuristic (handles app.derive.to + api.derive.to → derive.to, and the 3-label
// example.co.uk case); DERIVE_PASSKEY_RPID is the escape hatch for anything it misjudges.
const commonParent = (hosts: string[]): string | null => {
  const rev = hosts.map((h) => h.split(".").reverse())
  const first = rev[0]
  if (!first) return null
  let n = 0
  for (let i = 0; i < first.length; i++) {
    const label = first[i]
    if (rev.every((s) => s[i] === label)) n++
    else break
  }
  return n >= 2 ? first.slice(0, n).reverse().join(".") : null
}
export function resolvePasskey(opts: { baseUrl: string; webOrigins: string[] }): PasskeyConfig {
  const apiHost = hostOf(opts.baseUrl)
  const origin = [...new Set([opts.baseUrl, ...opts.webOrigins].map(originOf))]
  const override = process.env.DERIVE_PASSKEY_RPID
  // Web origins on a DIFFERENT host than the API (the true cross-site case). A different
  // port on the same host (localhost dev) is same-origin for WebAuthn.
  const webHosts = opts.webOrigins.map(hostOf).filter((h): h is string => !!h && h !== apiHost)
  if (webHosts.length === 0) return { enabled: !!apiHost, rpID: override, origin }
  const parent = override ?? (apiHost ? commonParent([apiHost, ...webHosts]) : null)
  return parent ? { enabled: true, rpID: parent, origin } : { enabled: false, origin }
}

// Scopes an agent can be granted via the OAuth consent. The derive:* scopes map to
// what the issued token may do; openid/profile/email/offline_access are the
// standard OIDC set the flow needs. Least-privilege default is propose+comment+read.
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "derive:read",
  "derive:comment",
  "derive:propose",
  "derive:publish",
  "derive:review",
  "derive:manage",
] as const

// How long an anonymous DCR-registered client (a headless agent that self-registered
// but hasn't had its human complete browser consent yet) survives before
// pruneStaleOAuthClients reaps it. An unconsented client is inert — it can't be used
// for anything without that consent — so this is pure DB hygiene against abandoned/spam
// registrations, not a security boundary. It used to be 24h, which was short enough that
// a real agent connector (Claude.ai, etc.) could register, sit unconsented over a
// weekend, and come back to a client_id that no longer existed — a dead end the human
// had no way to diagnose. 30 days makes that failure mode a near-non-issue; the
// authorize self-heal in app.ts (see `oauthClientExists`) covers what's left.
export const OAUTH_ANON_CLIENT_TTL_MS = 30 * 24 * 3600_000

const env = (k: string) => process.env[k]

/**
 * The RFC 8707 resource indicators an MCP client may bind its token to — the accepted
 * `aud` values. A superset of the plugin's default ([baseUrl]): the origin and the /mcp
 * endpoint in both slash forms, because MCP clients send the SERVER as the resource
 * (Claude Code sends the origin with a trailing slash; others send /mcp). Used on BOTH
 * sides so they can't drift: the AS side (`validAudiences`, what tokens may be minted for)
 * and the RS side (`oauthAgentFromJwt` audience validation, what tokens are accepted) —
 * the MCP-spec MUST that a server only accept tokens issued for it.
 */
export function mcpAudiences(baseUrl: string): string[] {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin
    } catch {
      return baseUrl.replace(/\/+$/, "")
    }
  })()
  return [...new Set([baseUrl, origin, `${origin}/`, `${origin}/mcp`, `${origin}/mcp/`])]
}

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
  /** Send a transactional auth email — password reset, email verification, or email-change
   *  confirmation. The caller renders it and enqueues onto the retrying email outbox, so
   *  makeAuth stays decoupled from the email module + its runtime. Unset (tests, or an entry
   *  with no outbox) ⇒ the email is simply not sent. */
  sendAuthEmail?: (
    kind: "reset" | "verify" | "change_email",
    input: { to: string; name: string | null; url: string },
  ) => void | Promise<void>
  /** Account-deletion guard: return a human reason to BLOCK deletion (e.g. the user is the
   *  sole owner of a shared workspace), or null to allow. Runs before Better Auth removes
   *  the account. */
  blockUserDeletion?: (userId: string) => Promise<string | null>
  /** Purge the user's Derive-domain data AFTER Better Auth deletes the account (the
   *  deleteUserData cascade). Unset (tests) ⇒ no cascade. */
  purgeUserData?: (userId: string) => Promise<void>
  /** Record where the signup came from: called once per created user with the raw
   *  Cookie header, so the d_src stamp (see lib/attribution.ts) becomes the account's
   *  signup_attribution row. Best-effort telemetry — failures never block creation.
   *  Unset (tests, schema-gen) ⇒ signups are simply unattributed. */
  recordSignupAttribution?: (userId: string, cookieHeader: string | null) => Promise<void>
}

export function makeAuth(db: AuthDb, baseUrl: string, secret: string, hooks: AuthHooks = {}) {
  // The browser sends its own Origin (the web app), which differs from the API's
  // baseURL whenever the SPA and API are on separate origins (dev proxy, or the
  // hosted split of static-web + API container). DERIVE_WEB_ORIGIN lists those in
  // production; localhost dev ports are trusted automatically.
  const webOrigins = (env("DERIVE_WEB_ORIGIN") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const devOrigins = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(baseUrl)
    ? ["http://localhost:3090", "http://localhost:5173"]
    : []
  const staticTrusted = [...new Set([baseUrl, ...webOrigins, ...devOrigins])]

  // The accepted RFC 8707 resource indicators (see mcpAudiences). A superset of the
  // plugin's default ([baseUrl]) so no previously-valid audience is narrowed; resource
  // validation only runs when a client sends `resource` (MCP clients do; derive login +
  // the browser consent flow don't), so other flows are untouched.
  const audiences = mcpAudiences(baseUrl)

  // Also trust a request whose Origin equals the origin it was actually served on
  // (its own Host). A same-origin request is never CSRF, so this is safe: a
  // cross-site attacker's Origin can never equal the victim browser's Host. It
  // rescues the common self-host footgun: a port-mapped container or reverse proxy
  // reached at an origin that doesn't exactly match BASE_URL (e.g. BASE_URL inferred
  // as :8080 but the host published :8081) would otherwise 403 INVALID_ORIGIN on
  // signup/login. Cross-origin (the real CSRF case) still requires an explicit
  // baseUrl / DERIVE_WEB_ORIGIN entry. A TLS-terminating proxy (browser https, app
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
  // GitHub sign-in (distinct from the repo-sync GitHub App): a standard OAuth app.
  // GITHUB_LOGIN_* rather than GITHUB_* so it's never confused with the App creds.
  const ghLoginId = env("GITHUB_LOGIN_CLIENT_ID")
  const ghLoginSecret = env("GITHUB_LOGIN_CLIENT_SECRET")
  if (ghLoginId && ghLoginSecret)
    socialProviders.github = { clientId: ghLoginId, clientSecret: ghLoginSecret }

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
  const crossSite = env("DERIVE_CROSS_SITE") === "true" || env("DERIVE_CROSS_SITE") === "1"

  // Passkeys (WebAuthn): on wherever the rpID/origin can be resolved (always for a
  // single-origin self-host; for the hosted split only when the SPA + API share a
  // registrable parent). See resolvePasskey.
  const passkeyCfg = resolvePasskey({ baseUrl, webOrigins })

  // Reject known-breached passwords on the password-setting endpoints (sign-up, reset,
  // change/set) via a before-hook — the public middleware API, so it doesn't couple to
  // Better Auth internals the way the stock plugin's hasher-wrap does. Default ON;
  // DERIVE_BREACH_CHECK=false opts out. Never runs under NODE_ENV=test (the suite signs up
  // with throwaway passwords and must not make a network call). The check itself fails OPEN
  // (see isBreachedPassword), so an air-gapped self-host is never blocked from creating an
  // account — this hook only rejects on a POSITIVE breach match.
  const breachCheck =
    env("DERIVE_BREACH_CHECK") !== "false" &&
    env("DERIVE_BREACH_CHECK") !== "0" &&
    env("NODE_ENV") !== "test"
  const BREACH_PATHS = new Set(["/sign-up/email", "/reset-password", "/change-password"])
  const breachGuard = createAuthMiddleware(async (ctx) => {
    if (!BREACH_PATHS.has(ctx.path)) return
    const body = ctx.body as { password?: unknown; newPassword?: unknown } | undefined
    const pw = typeof body?.password === "string" ? body.password : body?.newPassword
    if (typeof pw !== "string" || !pw) return
    try {
      if (await isBreachedPassword(pw))
        throw new APIError("BAD_REQUEST", {
          message: "That password has appeared in a data breach. Please choose a different one.",
          code: "PASSWORD_COMPROMISED",
        })
    } catch (e) {
      // Re-throw our own rejection; swallow anything else so a checker bug can't wall off
      // sign-in (defense in depth on top of isBreachedPassword's own fail-open).
      if (e instanceof APIError) throw e
      log.warn("breach check errored; allowing", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })

  return betterAuth({
    database: db,
    baseURL: baseUrl,
    secret,
    emailAndPassword: {
      enabled: true,
      // Reject too-short passwords server-side (the client enforces 8 too); the fail-open
      // breach check (breachGuard plugin below) additionally rejects known-compromised ones.
      minPasswordLength: 8,
      // A reset re-establishes account control, so drop every other live session.
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60, // 1h
      // Self-serve "forgot password": render + enqueue the reset link on the outbox. With
      // no real mail transport the link still rides the log sender (an operator reads it),
      // and capabilities reports passwordReset:false so the SPA hides the self-serve flow —
      // recovery is then the logged link + scripts/reset-password.mjs.
      sendResetPassword: async ({ user, url }) => {
        await hooks.sendAuthEmail?.("reset", { to: user.email, name: user.name ?? null, url })
      },
    },
    // Soft-nudge email verification: send on sign-up and sign the user in right after they
    // verify, but NEVER gate sign-in on it (requireEmailVerification would 403 the unverified),
    // so the sign-up → publish activation moment stays frictionless.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await hooks.sendAuthEmail?.("verify", { to: user.email, name: user.name ?? null, url })
      },
    },
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
          // Signup attribution: hand the arriving Cookie header (the d_src stamp) to
          // the app. Every provider — email, Google, OIDC — creates users through
          // this one path, and OAuth callbacks are top-level GETs, so the Lax cookie
          // rides along.
          after: async (user, ctx) => {
            try {
              const cookie =
                ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie") ?? null
              await hooks.recordSignupAttribution?.(user.id, cookie)
            } catch {
              // Best-effort telemetry: the account always wins.
            }
          },
        },
      },
    },
    user: {
      // Let a signed-in user delete their account. beforeDelete guards it (blocks when
      // they're the sole owner of a shared workspace); Better Auth then removes the account
      // + its sessions/accounts/passkeys/2FA, and afterDelete purges the Derive-domain data
      // (anonymize authorship, drop the personal workspace). No verification email is
      // configured, so the delete is immediate and gated by the client's password prompt.
      deleteUser: {
        enabled: true,
        beforeDelete: async (user: { id: string }) => {
          const reason = await hooks.blockUserDeletion?.(user.id)
          if (reason) throw new APIError("BAD_REQUEST", { message: reason })
        },
        afterDelete: async (user: { id: string }) => {
          await hooks.purgeUserData?.(user.id)
        },
      },
      // Let a signed-in user change their account email, confirming the NEW address via a
      // verification link (rendered + enqueued through the outbox, like reset/verify).
      changeEmail: {
        enabled: true,
        sendChangeEmailVerification: async ({
          user,
          newEmail,
          url,
        }: {
          user: { name?: string | null }
          newEmail: string
          url: string
        }) => {
          await hooks.sendAuthEmail?.("change_email", {
            to: newEmail,
            name: user.name ?? null,
            url,
          })
        },
      },
      additionalFields: {
        // The public handle (Profiles & Accounts v1). Claimed at onboarding via
        // POST /v1/me/username, so it's server-controlled and never accepted
        // straight from a sign-up payload (input:false). Nullable until claimed.
        // NOT declared `unique` here: Better Auth would render that as a column
        // constraint, and on an existing DB its migration emits
        // `ALTER TABLE user ADD COLUMN username TEXT UNIQUE`, which SQLite rejects
        // ("Cannot add a UNIQUE column"). Instead Better Auth adds a plain column
        // and ensureAuthIndexes() creates the `user_username` UNIQUE INDEX after
        // migration — valid on both dialects (multiple NULLs are allowed), and the
        // hard backstop behind the usernameTaken assignment hook.
        username: { type: "string", required: false, input: false },
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
        // Has the account finished (or skipped) first-run onboarding? Server-authoritative
        // so it syncs across devices and survives a cleared localStorage — the client flag
        // is only a fast-path cache. Defaults false (new accounts land on /welcome); set
        // true via POST /v1/me/onboarded. input:false, server-set only.
        onboarded: { type: "boolean", required: false, defaultValue: false, input: false },
        // Your personal Brandprint: how YOU like artifacts built. Stored as a JSON string
        // ({ collectionId? }); layered over the workspace Brandprint (profile wins)
        // when an agent acts as you. input:false, server-set via POST /v1/me/profile.
        brandprint: { type: "string", required: false, input: false },
      },
    },
    socialProviders,
    trustedOrigins: trusted,
    plugins: [
      ...(oidc.length ? [genericOAuth({ config: oidc })] : []),
      // Passkeys / WebAuthn — the phishing-resistant, passwordless factor, promoted on the
      // login page. Added as a sign-in method + post-auth enrollment (requireSession stays
      // on), never a passkey-first sign-UP, so registration stays simple. rpID/origin from
      // resolvePasskey; the plugin adds a `passkey` table (created by migrateAuth).
      ...(passkeyCfg.enabled
        ? [
            passkey({
              rpName: "Derive",
              ...(passkeyCfg.rpID ? { rpID: passkeyCfg.rpID } : {}),
              origin: passkeyCfg.origin,
            }),
          ]
        : []),
      // Opt-in TOTP two-factor (authenticator apps) + one-time backup codes. Zero external
      // dependency — the secret + codes live in Better Auth's own tables (created by
      // migrateAuth). A user enables it in Settings → Security; when on, sign-in becomes a
      // two-step flow (password → code) the client handles via the twoFactorRedirect result.
      twoFactor({ issuer: "Derive" }),
      // oauthProvider signs id tokens + serves JWKS through the jwt plugin.
      jwt(),
      // Derive as an OAuth 2.1 authorization server: agents (MCP clients) authenticate
      // via a browser consent instead of a pasted token, and get a scoped, expiring
      // access token. Endpoints land under /api/auth/oauth2/*; the consent screen is
      // a route we own (/oauth/consent). Tokens are opaque and stored hashed with
      // Derive's own sha256, so the bridge can resolve them by hash (see context.ts).
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
        // 24h, not the textbook 1h: these are opaque tokens resolved by DB hash on
        // every request (see storeTokens below), so revocation is immediate no matter
        // the TTL - the short-expiry rationale for bearer JWTs doesn't apply. A day
        // saves agent CLIs (sessions typically hours apart) a refresh round-trip per
        // session; the rotating refresh token below still bounds abandoned clients.
        accessTokenExpiresIn: 60 * 60 * 24, // 24h
        // Refresh tokens rotate + reset their window on every use (see createUserTokens),
        // so this is an INACTIVITY timeout, not a hard cap: you only re-consent after a
        // full year of not using a client. A year, not the previous 30d, because this
        // bound buys almost nothing here — refresh tokens are opaque, stored hashed, and
        // resolved by DB lookup, so a leaked DB row is unusable and real revocation is
        // deleting the row (immediate at any TTL). The only thing the window bounds is
        // how long an abandoned-but-consented client could sit idle and still come back,
        // and re-consenting yearly is the right cost for that on a personal instance.
        refreshTokenExpiresIn: 60 * 60 * 24 * 365, // 365d (idle)
        scopes: [...OAUTH_SCOPES],
        // Accept the resource indicators MCP clients send (else token exchange 400s).
        validAudiences: audiences,
        storeTokens: { hash: async (token) => sha256(token) },
      }),
    ],
    ...(breachCheck ? { hooks: { before: breachGuard } } : {}),
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
