import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import { OAUTH_SCOPES, resolvePasskey } from "../auth-config"
import { isCapabilityOn } from "../config-manifest"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { cliCallbackHTML } from "../oauth-cli-callback"
import { consentHTML } from "../oauth-consent"

/** OAuth/OIDC discovery at the well-known root, the branded consent + CLI-callback
 *  screens, and the public list of configured social sign-in providers. Read-only,
 *  except the consent screen's workspace binding (POST /oauth/consent/workspace).
 *  AuthCapabilities is generated for the web; the well-known discovery + HTML screens
 *  stay plain routes. */
export const oauthRoutes = (ctx: AppContext) => {
  const { meta, currentUser } = ctx
  const app = new OpenAPIHono<BlankEnv>()

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
  // OIDC discovery for standards-compliant OIDC clients.
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
    const me = await currentUser(c)
    const mine = me ? await meta.listWorkspaces(me.id) : []
    // Re-consent preselect: the workspaces a prior grant was scoped to, kept only
    // where the user is still a member. Empty → the "All workspaces" default.
    const bound = me && clientId ? await meta.getOAuthClientWorkspaces(me.id, clientId) : []
    const selected = bound.filter((id) => mine.some((w) => w.id === id))
    return c.html(
      consentHTML({
        clientName,
        scopes,
        query: new URL(c.req.url).search,
        clientId,
        workspaces: mine.map((w) => ({ id: w.id, name: w.name })),
        selected,
      }),
    )
  })

  // Persist the consent screen's workspace choice: this user's grants to this
  // client act in org_id. The binding is keyed by the session user, so it can
  // only ever affect the caller's own grants; org_id is membership-checked.
  app.openapi(
    createRoute({
      method: "post",
      path: "/oauth/consent/workspace",
      tags: ["OAuth"],
      summary: "Scope an OAuth client's grants to a set of workspaces (consent screen).",
      responses: {
        200: {
          description: "The workspace scope was saved.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      // Strict same-origin. The consent page is served from this origin, so its
      // fetch always carries a matching Origin header; a cross-site page never can
      // — and in DERIVE_CROSS_SITE deployments the session cookie is SameSite=None,
      // so without this check a text/plain form could smuggle a JSON body here
      // with the victim's cookie attached.
      const origin = c.req.header("origin")
      if (!origin || origin !== new URL(c.req.url).origin)
        return bail(fail(c, 403, "cross-origin request refused"))
      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "sign in to continue"))
      const b = await readJson(
        c,
        z.object({ client_id: z.string().min(1), org_ids: z.array(z.string()) }),
      )
      if (b instanceof Response) return bail(b)
      // Every ticked workspace must be one the caller is a member of; an empty array
      // clears the scope → "All workspaces". Membership is re-checked server-side so
      // a stale or forged id can never widen the grant past the human's own reach.
      const valid: string[] = []
      for (const orgId of b.org_ids) {
        if (await meta.getMembership(orgId, me.id)) valid.push(orgId)
      }
      if (valid.length !== b.org_ids.length) return bail(fail(c, 403, "forbidden"))
      await meta.setOAuthClientWorkspaces(me.id, b.client_id, valid)
      return c.json({ ok: true })
    },
  )

  // Hosted callback for the CLI/native OAuth flow (`derive login`). HTML — plain route.
  app.get("/oauth/cli-callback", (c) => {
    const code = c.req.query("code")
    const error = c.req.query("error_description") ?? c.req.query("error")
    return c.html(cliCallbackHTML({ code, error }))
  })

  // The auth capabilities this instance actually has — the single contract that lets
  // the SPA render only the sign-in methods + flows that really work here. Public +
  // read-only; everything is env/feature-detected (config-manifest), the SAME gate
  // `derive doctor` uses, so the two can't disagree.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/auth/capabilities",
      tags: ["OAuth"],
      summary: "The sign-in methods + flows this instance actually has (capability-adaptive).",
      responses: {
        200: {
          description: "What the login page + Security hub may render here.",
          content: {
            "application/json": {
              schema: z
                .object({
                  password: z
                    .boolean()
                    .describe("True if email + password sign-in is available (always on here)"),
                  google: z.boolean().describe("True if Google sign-in is configured"),
                  github: z.boolean().describe("True if GitHub sign-in is configured"),
                  oidc: z
                    .object({
                      providerId: z.string().describe("The provider id used to initiate SSO"),
                      label: z.string().describe("Human-readable label for the SSO button"),
                    })
                    .nullable()
                    .describe("The enterprise OIDC/SSO provider, or null if none is configured"),
                  emailVerification: z
                    .boolean()
                    .describe(
                      "True if verification emails can be sent (a mail transport is configured)",
                    ),
                  passwordReset: z.boolean().describe("True if password-reset emails can be sent"),
                  passkey: z
                    .boolean()
                    .describe("True if passkey (WebAuthn) sign-in works on this instance"),
                })
                .openapi("AuthCapabilities"),
            },
          },
        },
      },
    }),
    (c) => {
      return c.json({
        // Email+password is enabled unconditionally in auth-config, so it's always here.
        password: true,
        // Social / enterprise SSO — provider on/off comes from the shared capability model.
        google: isCapabilityOn("google", process.env),
        github: isCapabilityOn("github", process.env),
        oidc: isCapabilityOn("oidc", process.env)
          ? {
              providerId: process.env.OIDC_PROVIDER_ID ?? "sso",
              label: process.env.OIDC_PROVIDER_LABEL ?? "SSO",
            }
          : null,
        // Mail-dependent flows: live only when a real transport is configured.
        emailVerification: !!ctx.deps.emailEnabled,
        passwordReset: !!ctx.deps.emailEnabled,
        // Passkeys: on wherever the rpID/origin resolves.
        passkey: resolvePasskey({
          baseUrl: ctx.deps.baseUrl,
          webOrigins: [...ctx.allowOrigins],
        }).enabled,
      })
    },
  )

  return app
}
