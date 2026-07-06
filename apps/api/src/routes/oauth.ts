import { type Context, Hono } from "hono"
import { OAUTH_SCOPES } from "../auth-config"
import type { AppContext } from "../context"
import { cliCallbackHTML } from "../oauth-cli-callback"
import { consentHTML } from "../oauth-consent"

/** OAuth/OIDC discovery at the well-known root, the branded consent + CLI-callback
 *  screens, and the public list of configured social sign-in providers. All read-only. */
export const oauthRoutes = (ctx: AppContext) => {
  const { meta } = ctx
  const app = new Hono()

  // OAuth 2.0 discovery at the well-known root (RFC 8414 + RFC 9728), mirroring
  // what the oidc-provider plugin serves under /api/auth — MCP clients and standard
  // OAuth tooling probe the root. Issuer is the live request origin so it's correct
  // behind any proxy / on workers.dev without configuration.
  const asMeta = (c: Context) => {
    const base = new URL(c.req.url).origin
    return {
      issuer: base,
      authorization_endpoint: `${base}/api/auth/oauth2/authorize`,
      token_endpoint: `${base}/api/auth/oauth2/token`,
      registration_endpoint: `${base}/api/auth/oauth2/register`,
      userinfo_endpoint: `${base}/api/auth/oauth2/userinfo`,
      jwks_uri: `${base}/api/auth/jwks`,
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    }
  }
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(asMeta(c)))
  // OIDC discovery for standards-compliant OIDC clients. We issue id tokens (jwt
  // plugin) + advertise the openid scope + a userinfo endpoint, so RPs that probe
  // /.well-known/openid-configuration must get JSON here — previously this path fell
  // through to the SPA shell (HTML 200), breaking discovery. Superset of the OAuth AS
  // metadata with the two OIDC-required fields.
  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      ...asMeta(c),
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
    }),
  )
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const base = new URL(c.req.url).origin
    return c.json({
      resource: base,
      authorization_servers: [base],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
    })
  })

  // The consent screen the oauth-provider plugin redirects a signed-in user to
  // (client_id + scope + code in the query). We render the branded grant page; on
  // Approve it posts back to /api/auth/oauth2/consent, which completes the flow.
  app.get("/oauth/consent", async (c) => {
    const clientId = c.req.query("client_id") ?? ""
    const scopes = (c.req.query("scope") ?? "").split(/\s+/).filter(Boolean)
    const clientName = (await meta.getOAuthClientName(clientId)) || clientId || "An application"
    return c.html(consentHTML({ clientName, scopes, query: new URL(c.req.url).search }))
  })

  // Hosted callback for the CLI/native OAuth flow (`derive login`). A command-line
  // client registers this as its redirect_uri instead of localhost; after consent
  // the browser lands here with the one-time code, which we display for the user to
  // paste back into the terminal (the PKCE verifier stays on their machine).
  app.get("/oauth/cli-callback", (c) => {
    const code = c.req.query("code")
    const error = c.req.query("error_description") ?? c.req.query("error")
    return c.html(cliCallbackHTML({ code, error }))
  })

  // The auth capabilities this instance actually has — the single contract that lets
  // the SPA render only the sign-in methods + flows that really work here (the
  // capability-adaptive design: one binary, self-host and hosted differ only by what's
  // configured). Everything is env/feature-detected, so a bare self-host reports a
  // smaller set than a fully-wired hosted deploy with NO code change. Public +
  // read-only. Later phases extend this (emailVerification, passwordReset, passkey,
  // twoFactor) as those flows land — a field appears only once its endpoints exist.
  app.get("/v1/auth/capabilities", (c) => {
    const oidcOn = !!(
      process.env.OIDC_ISSUER &&
      process.env.OIDC_CLIENT_ID &&
      process.env.OIDC_CLIENT_SECRET
    )
    return c.json({
      // Email+password is enabled unconditionally in auth-config, so it's always here.
      password: true,
      // Social / enterprise SSO — env-gated in auth-config; the login page renders a
      // button only when the capability is present. OIDC carries the provider id the
      // client needs to start the generic-OAuth sign-in, plus a display label.
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      github: !!(process.env.GITHUB_LOGIN_CLIENT_ID && process.env.GITHUB_LOGIN_CLIENT_SECRET),
      oidc: oidcOn
        ? {
            providerId: process.env.OIDC_PROVIDER_ID ?? "sso",
            label: process.env.OIDC_PROVIDER_LABEL ?? "SSO",
          }
        : null,
      // Mail-dependent flows: live only when a real transport is configured (else the
      // SPA hides "Forgot password?" + the verify banner — recovery is the logged link +
      // operator script, and verification is moot without delivery).
      emailVerification: !!ctx.deps.emailEnabled,
      passwordReset: !!ctx.deps.emailEnabled,
    })
  })

  return app
}
