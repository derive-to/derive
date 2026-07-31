/**
 * Connecting an MCP server by SIGNING IN, instead of pasting a long-lived key.
 *
 * Two routes and one problem worth explaining.
 *
 * THE ROUTES. `POST /v1/connections/:id/authorize` discovers the server's authorization server,
 * registers Derive as a client if the server supports it, and hands back a URL to send the person
 * to. `GET /v1/connections/oauth/callback` receives them back, exchanges the code, stores the
 * token, and only then can the connection become usable.
 *
 * THE PROBLEM. Everywhere else in this codebase a connection is born complete: `connect()` lists
 * the server's tools and mints `mcp:<pin>:<url>` in one step, and `toolsFor` REFUSES any ref
 * whose pin is empty — that refusal is the whole tool-poisoning defense, so it cannot be softened.
 * But an OAuth connection cannot list anything until after consent comes back, which is a second
 * HTTP round trip and a different request. So the row is created `pending` with an unpinned ref
 * (unusable by construction, which is the correct resting state for a half-finished connection),
 * and the callback is what lists the tools, computes the pin, rewrites the ref and flips it
 * `active`. Re-pinning after the fact is the one part of this no library does for us.
 *
 * WHO MAY FINISH IT. Signed state proves who STARTED the flow; it rides in a URL and is
 * replayable inside its window, so it cannot also prove who finished it. A live session must, and
 * must match. Same rule the Slack identity link already applies, for the same reason.
 */

import { McpBroker } from "@derive/broker"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { signCapabilityToken, verifyCapabilityToken } from "../lib/capability-token"
import { fail } from "../lib/http"
import { type McpOauthCredential, serializeCredential } from "../lib/mcp-oauth"

/** Its own signing domain, so a state token cannot be replayed as any other capability. */
const STATE_DOMAIN = "derive-mcp-oauth-state:"
/** Long enough to read a consent screen and sign in; short enough that a leaked URL goes stale. */
const STATE_TTL_MS = 15 * 60_000

/** Where the provider sends the person back. One route for every server. */
export const callbackUri = (baseUrl: string): string =>
  new URL("/v1/connections/oauth/callback", baseUrl).toString()

/**
 * The PKCE verifier has to survive the round trip, and it must not be guessable from the state.
 * It rides inside the signed state itself: the state is HMAC'd with the server's own secret, so a
 * caller can neither forge nor read it as anything but an opaque string, and nothing extra has to
 * be stored for a flow that may never be completed.
 */
interface OauthState {
  connectionId: string
  orgId: string
  userId: string
  verifier: string
  authServer: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  resource?: string
}

/**
 * The whole state travels as ONE base64url field, not as nine.
 *
 * `signCapabilityToken` joins its fields with "." and recovers only the expiry structurally —
 * everything before it comes back rejoined, so a kind with several fields has to "pick separators
 * its field values can't contain". Half of these fields are URLs, and every real one has dots in
 * it: `https://mcp.stripe.com` would split into four. Encoding the JSON once removes the question,
 * and base64url is dot-free by construction.
 */
const packState = (s: OauthState): string[] => {
  const bytes = new TextEncoder().encode(JSON.stringify(s))
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return [btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")]
}

const unpackState = (rest: string): OauthState | null => {
  try {
    const b64 = rest.replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const bin = atob(padded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const s = JSON.parse(new TextDecoder().decode(bytes)) as OauthState
    // The signature already proves we minted it; this only guards against an older token shape.
    if (!s?.connectionId || !s.orgId || !s.userId || !s.verifier || !s.tokenEndpoint) return null
    if (!s.authServer || !s.clientId) return null
    return s
  } catch {
    return null
  }
}

export const mcpOauthRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireWorkspace, deps } = ctx
  const app = new Hono()

  /**
   * Begin the flow for a connection that is waiting on authorization. Returns the URL to send the
   * person to; the caller opens it. Deliberately a POST that returns a URL rather than a redirect,
   * so the SPA keeps control of the navigation and can show its own "opening Stripe…" state.
   */
  app.post("/v1/connections/:id/authorize", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    // The same secret the other integrations sign state with — the Node and Worker entries pass
    // the auth secret in as `encryptionKey`, and Slack's install flow already uses it this way.
    const secret = deps.encryptionKey
    if (!secret) return fail(c, 502, "this deployment cannot complete an OAuth connection")

    const cn = await meta.getConnection(c.req.param("id"))
    if (!cn || cn.org_id !== org) return fail(c, 404, "not found")
    // A personal connection is its owner's grant and nobody else's to start.
    if (cn.scope === "personal" && cn.user_id !== me.id) return fail(c, 403, "forbidden")
    if (cn.kind !== "mcp" || !cn.base_url) return fail(c, 400, "not an MCP connection")

    try {
      const serverUrl = cn.base_url
      const prm = await discoverOAuthProtectedResourceMetadata(serverUrl).catch(() => undefined)
      const authServer = prm?.authorization_servers?.[0] ?? serverUrl
      const md = await discoverAuthorizationServerMetadata(authServer)
      if (!md?.token_endpoint) return fail(c, 400, "that server does not advertise OAuth")

      // Register per (server, deployment). Servers that offer registration hand back a public
      // client — Stripe's advertises `token_endpoint_auth_methods_supported: ["none"]` — which is
      // exactly the shape PKCE is designed for and needs no secret of ours anywhere.
      const redirectUri = callbackUri(deps.baseUrl)
      const client = md.registration_endpoint
        ? await registerClient(authServer, {
            metadata: md,
            clientMetadata: {
              client_name: "Derive",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
          })
        : undefined
      if (!client?.client_id)
        return fail(
          c,
          400,
          "that server needs a pre-registered client, which this deployment has not configured",
        )

      const { authorizationUrl, codeVerifier } = await startAuthorization(authServer, {
        metadata: md,
        clientInformation: client,
        redirectUrl: redirectUri,
        ...(md.scopes_supported?.length ? { scope: md.scopes_supported.join(" ") } : {}),
        resource: new URL(serverUrl),
      })

      const state = await signCapabilityToken(
        STATE_DOMAIN,
        secret,
        packState({
          connectionId: cn.id,
          orgId: org,
          userId: me.id,
          verifier: codeVerifier,
          authServer,
          tokenEndpoint: md.token_endpoint,
          clientId: client.client_id,
          ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
          resource: serverUrl,
        }),
        Date.now() + STATE_TTL_MS,
      )
      const url = new URL(authorizationUrl)
      url.searchParams.set("state", state)
      return c.json({ authorize_url: url.toString() })
    } catch (e) {
      return fail(c, 400, `could not start authorization: ${(e as Error).message}`.slice(0, 200))
    }
  })

  /**
   * The return leg. A top-level GET, like the Slack and GitHub callbacks, which is what passes the
   * anonymous-write lockdown — and it still requires a live session below.
   */
  app.get("/v1/connections/oauth/callback", async (c) => {
    const secret = deps.encryptionKey
    const code = c.req.query("code")
    const stateRaw = c.req.query("state")
    if (!secret) return fail(c, 502, "OAuth is not configured")
    if (c.req.query("error"))
      return fail(c, 400, `authorization was declined: ${c.req.query("error")}`)
    if (!code || !stateRaw) return fail(c, 400, "invalid callback")

    const verified = await verifyCapabilityToken(STATE_DOMAIN, secret, stateRaw, Date.now())
    const state = verified ? unpackState(verified.rest) : null
    if (!state) return fail(c, 400, "that authorization link has expired — start again")

    // State proves who STARTED it. It rides in a URL and is replayable inside its window, so a
    // live session has to prove who FINISHES it, and they must be the same person.
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (me.id !== state.userId) return fail(c, 403, "sign in as the person who started this")

    const cn = await meta.getConnection(state.connectionId)
    if (!cn || cn.org_id !== state.orgId) return fail(c, 404, "not found")

    try {
      const tokens = await exchangeAuthorization(state.authServer, {
        metadata: { token_endpoint: state.tokenEndpoint } as never,
        clientInformation: { client_id: state.clientId, client_secret: state.clientSecret },
        authorizationCode: code,
        codeVerifier: state.verifier,
        redirectUri: callbackUri(deps.baseUrl),
        ...(state.resource ? { resource: new URL(state.resource) } : {}),
      })

      const cred: McpOauthCredential = {
        v: 1,
        access_token: tokens.access_token,
        ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
        ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
        token_endpoint: state.tokenEndpoint,
        authorization_server: state.authServer,
        client_id: state.clientId,
        ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
        ...(state.resource ? { resource: state.resource } : {}),
      }
      const secretEnc = serializeCredential(cred, secret)

      // NOW list the tools, with the token we just obtained, and pin what came back. This is the
      // step `connect()` does inline for a pasted key and cannot do here, because until this
      // moment there was no credential to list with.
      const broker = new McpBroker(undefined, () => cred.access_token)
      const link = await broker.connect({
        orgId: cn.org_id,
        userId: cn.user_id,
        toolkit: cn.base_url ?? "",
      })
      if (link.status !== "active") {
        // Authorized, but the server still would not list. Keep the credential (it is valid and
        // re-listing is cheap) and leave the row pending rather than pretending it is usable.
        await meta.updateConnectionCredential(cn.id, cn.org_id, { secret_enc: secretEnc })
        return fail(
          c,
          400,
          "signed in, but that server would not list its tools — try reconnecting",
        )
      }

      await meta.updateConnectionCredential(cn.id, cn.org_id, {
        secret_enc: secretEnc,
        broker_ref: link.ref,
        status: "active",
        scopes_label: "signed in",
      })
      // Back to where they started, not to a JSON body: this is a browser navigation.
      return c.redirect(new URL("/settings?tab=sources&connected=1", deps.baseUrl).toString(), 302)
    } catch (e) {
      return fail(c, 400, `could not complete authorization: ${(e as Error).message}`.slice(0, 200))
    }
  })

  return app
}
