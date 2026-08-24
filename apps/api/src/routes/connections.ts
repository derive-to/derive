import { isAllowedOutboundUrl, McpBroker } from "@derive/broker"
import { type ConnectionRecord, newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { brokerFor, isDirect } from "../lib/broker"
import { encryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

// WO3 — connected external accounts (Sources). Connect once (OAuth via the broker), then
// instructions name the tool in plain language. Two scopes: "personal" (act-as-me — bound to
// the caller, only they may attach it, dies with their membership) and "workspace" (org
// infrastructure — admin-managed, survives the adder leaving; user_id is provenance only).
// A hosted run sees the tools of its bound connections only. The BYO path never touches
// these. broker_ref is the broker-side connected-account id.

// An allowlist, not a spread: secret_enc must never ride a response, at any role, including
// over a minted dkapi_ bearer. A pasted credential is write-only once it is stored.
const present = (cn: ConnectionRecord) => ({
  id: cn.id,
  org_id: cn.org_id,
  user_id: cn.user_id,
  scope: cn.scope,
  kind: cn.kind,
  base_url: cn.base_url,
  broker: cn.broker,
  toolkit: cn.toolkit,
  scopes_label: cn.scopes_label,
  status: cn.status,
  created_at: cn.created_at,
})

// What to say when someone wires up an integration Derive isn't connected to yet. The fix
// is the integration's own setup flow, not this endpoint — so the message points there.
const installMissing: Record<"slack", string> = {
  slack: "connect Slack to this workspace first (Settings → Slack), then add it as a connection",
}

export const connectionRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireWorkspace, deps } = ctx
  const app = new Hono()

  app.get("/v1/connections", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    // ?mine=1 → the caller's own PERSONAL connections (a workspace row they happened to
    // add is the org's, not theirs). ?scope=workspace|personal filters by scope alone.
    const scopeQ = c.req.query("scope")
    const scope =
      scopeQ === "workspace" || scopeQ === "personal"
        ? scopeQ
        : c.req.query("mine") === "1"
          ? "personal"
          : undefined
    const scoped = c.req.query("mine") === "1" ? me.id : undefined
    return c.json({ connections: (await meta.listConnections(org, scoped, scope)).map(present) })
  })

  app.post("/v1/connections", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(
      c,
      z.object({
        // Slug-shaped because it becomes the prefix of the tool names a model reads
        // (`github.get`): whitespace or a dot would make the surface ambiguous.
        // Ignored for Slack, which names itself.
        toolkit: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "toolkit must be a lowercase slug")
          .optional(),
        scopes_label: z.string().max(200).optional(),
        /** Connect an MCP server directly: no vendor account, no OAuth round trip, and it works
         *  in a workspace with NO broker plan — which is every workspace today. Routes on its own
         *  URL rather than the workspace's plan, so it is orthogonal to `kind` below (an MCP
         *  server still authenticates however it chooses; Derive holds no credential for it). */
        mcp_url: z.string().url().max(2000).optional(),
        /** Bearer token for an MCP server that requires one — which is most of the useful ones,
         *  and the reason a connection to them used to be impossible. Sent as
         *  `Authorization: Bearer`, the only scheme the MCP authorization spec defines; a server
         *  wanting some other header is an escalation, not a config field. Write-only: encrypted
         *  at rest, spent server-side, never present in any response. */
        mcp_secret: z.string().min(8).max(4096).optional(),
        // "personal" (default) = the caller's own account. "workspace" = org
        // infrastructure — requires manage, because whoever can add a workspace
        // credential decides what every context bound to it can reach.
        scope: z.enum(["personal", "workspace"]).default("personal"),
        // How it authenticates. "oauth" (default) = broker round trip. "secret" = paste
        // a key. "slack" = give an install Derive ALREADY holds a tool surface; it
        // stores no credential of its own. GitHub connections are created only by the
        // dedicated verified installation flow under /v1/github.
        kind: z.enum(["oauth", "secret", "slack"]).default("oauth"),
        // kind "secret" only:
        secret: z.string().min(8).max(4096).optional(),
        // nullish, not optional: GET /v1/connections renders an absent host as `base_url: null`,
        // and round-tripping that object straight back into this route is the obvious client
        // pattern — it should not 400 on the shape we just handed out.
        base_url: z.string().url().max(500).nullish(),
      }),
    )
    if (b instanceof Response) return bail(b)
    // An install-backed connection is org infrastructure by construction — the install
    // belongs to the workspace, not to whoever happens to wire it up.
    const scope = b.kind === "slack" ? "workspace" : b.scope
    if (scope === "workspace") {
      const gate = await requireWorkspace(c, "manage")
      if (gate instanceof Response) return gate
    }
    if (b.kind === "slack") {
      // Point at what the workspace already connected. Nothing is created here and no
      // OAuth is started — if the install is missing, the integration's own flow is
      // where you go.
      const install = await meta
        .getSlackInstall(org)
        .then((i) => i && { ref: i.team_id, label: i.team_name })
      if (!install) return fail(c, 400, installMissing[b.kind])
      // One install, one connection: re-wiring is idempotent rather than piling up rows
      // that all point at the same place and can't be told apart in a picker.
      const existing = (await meta.listConnections(org, undefined, "workspace")).find(
        (x) => x.kind === b.kind && x.broker_ref === install.ref && x.status === "active",
      )
      if (existing) return c.json(present(existing))
      const rec = await meta.createConnection({
        id: newId("conn"),
        org_id: org,
        user_id: me.id,
        scope: "workspace",
        kind: b.kind,
        // Deliberately no secret_enc: the credential is minted or read per call from the
        // install this ref points at, so there is nothing here to leak or to rotate.
        broker: "none",
        toolkit: "slack",
        broker_ref: install.ref,
        base_url: "https://slack.com/api",
        scopes_label: b.scopes_label ?? install.label,
        status: "active",
      })
      return c.json(present(rec), 201)
    }
    if (!b.toolkit) return fail(c, 400, "toolkit is required")
    // Checked HERE, not left to McpBroker.connect, which throws — the same rule the secret
    // branch applies to base_url below, and a pasted URL is user input, so it earns a 400
    // rather than a 500.
    //
    // ONE predicate, shared with the broker and used for `base_url` below as well — see
    // `isAllowedOutboundUrl` for the two string tests this replaced and how each was bypassed.
    if (b.mcp_url && !isAllowedOutboundUrl(b.mcp_url))
      return fail(c, 400, "mcp_url must be https (or http://localhost for dev)")
    // The same 502 the `secret` branch raises, and for a worse reason if skipped: the token
    // authenticates THIS connect (it is still in memory) and is then dropped, so the row stores
    // no credential, the UI says "Connected", and every later run gets a 401 the ledger reports
    // as "the server could not be reached". A source that is permanently dead and claims to be
    // healthy is the worst outcome available.
    if (b.mcp_url && b.mcp_secret && !deps.encryptionKey)
      return fail(c, 502, "storing an MCP token needs an encryption key")
    if (b.kind === "secret") {
      if (!b.secret) return fail(c, 400, "a secret connection needs `secret`")
      // base_url is OPTIONAL. Credentials are delivered into runs, so nothing confines a
      // pasted key to a host and there is no boundary for this field to express: a
      // recognized vendor's host is ours to know, and an unrecognized key gets a free-text
      // note instead. It stays supported because the machineless lane (no container, so the
      // agent cannot run code) resolves paths against it and confines to it — see httpTools.
      // When present it is still held to https, since that lane will send a credential there.
      // The dev escape hatch is the LOCALHOST HOST, not the prefix: `startsWith("http://localhost")`
      // also accepts http://localhost.evil.com, which would send a decrypted bearer to someone
      // else's box in cleartext. Parse and compare the hostname instead.
      if (b.base_url && !isAllowedOutboundUrl(b.base_url))
        return fail(c, 400, "base_url must be https (or http://localhost for dev)")
      if (!deps.encryptionKey) return fail(c, 502, "secret connections need an encryption key")
      const rec = await meta.createConnection({
        id: newId("conn"),
        org_id: org,
        user_id: me.id,
        scope: b.scope,
        kind: "secret",
        secret_enc: encryptSecret(b.secret, deps.encryptionKey),
        // Stored without a trailing slash; executeHttpTool adds one when it resolves a path.
        base_url: b.base_url ? b.base_url.replace(/\/+$/, "") : null,
        broker: "none",
        toolkit: b.toolkit,
        // There is no vendor account behind this, but a run still identifies its tools by
        // ref, so mint a synthetic one. Nothing parses it — routing is on `kind`.
        broker_ref: newId("sref"),
        // Display hint, never the credential. The default is the last 4 characters, which
        // is how someone recognizes which key they pasted.
        scopes_label: b.scopes_label ?? `…${b.secret.slice(-4)}`,
        // Nothing to authorize, so it is usable immediately.
        status: "active",
      })
      return c.json(present(rec), 201)
    }
    // An MCP connection routes on its OWN URL rather than the workspace's broker plan, and is
    // built per request (it holds only a session map, no credential) so nothing is cached across
    // tenants. Everything else resolves a plan: a workspace connection from the pool (it must not
    // ride — and die with — one member's personal plan), a personal one from the caller.
    // An MCP server that needs a credential gets it HERE, at connect, so the tool list it is
    // pinned against is the one it serves to an authenticated caller. Without this the connect
    // 401s, mints an UNPINNED ref, and the connection is dead on arrival — which is the state
    // every auth-required server used to land in.
    const broker = b.mcp_url
      ? new McpBroker(undefined, () => b.mcp_secret)
      : await brokerFor(
          meta,
          org,
          b.scope === "workspace" ? null : me.id,
          deps.encryptionKey,
          deps.allowEchoStub,
        )
    // `toolkit` stays the human label on the row either way; for MCP the SERVER URL is what the
    // broker connects to, and the ref it mints (`mcp:<pin>:<url>`) is what routing keys on.
    const link = await broker.connect({
      orgId: org,
      userId: me.id,
      toolkit: b.mcp_url ?? b.toolkit,
    })
    // A server that refuses to authenticate must not be stored as a usable connection. `connect`
    // reports `pending` for both "unreachable" and "unauthorized", and a pending row is filtered
    // out of every run — so the useful thing to do is say so now, while a human is watching.
    // A server that wants authorization and was given no token is not a failure — it is the
    // START of the OAuth flow. Store the row `pending` (unpinned, so no run can use it) and hand
    // it back with the reason, so the client can immediately offer "Sign in". Every other failure
    // still refuses at the door: there is nothing to complete and a stored row would be a
    // connection that can never come good.
    const awaitingAuth = b.mcp_url && link.reason === "auth_required" && !b.mcp_secret
    if (b.mcp_url && link.status !== "active" && !awaitingAuth) {
      // Say which of the four it was. These are the exact words a person reads at the moment they
      // are deciding whether this product works, and until now all four said "did not answer".
      const url = b.mcp_url
      // Parse rather than string-match: a pasted URL can carry a query or a trailing slash, and
      // the suggestion has to preserve everything except the path segment that is wrong.
      const rootOf = (raw: string): string | null => {
        try {
          const u = new URL(raw)
          if (!/\/mcp\/?$/.test(u.pathname)) return null
          u.pathname = u.pathname.replace(/\/mcp\/?$/, "") || "/"
          return u.toString().replace(/\/$/, "")
        } catch {
          return null
        }
      }
      const root = rootOf(url)
      const trimmed = root ?? url
      const messages: Record<string, string> = {
        auth_required: b.mcp_secret
          ? "that server refused the token — check it is valid and has the scopes the server needs"
          : "that server needs authorization: sign in with it, or paste a token",
        not_mcp:
          trimmed !== url
            ? `no MCP server answered at ${url}. Many servers live at the root — try ${trimmed}`
            : `no MCP server answered at ${url} — check the URL`,
        unreachable: "could not reach that server at all — check the URL and that it is running",
        protocol_error: "that server answered, but not in a way Derive could use",
      }
      return fail(
        c,
        400,
        messages[link.reason ?? ""] ??
          "that MCP server did not answer — if it requires authentication, pass `mcp_secret`",
        // The machine-readable half, so the UI can offer "Sign in" rather than parse prose.
        link.reason ? { reason: link.reason } : undefined,
      )
    }
    const rec = await meta.createConnection({
      id: newId("conn"),
      org_id: org,
      user_id: me.id, // personal: the owner (never falls back). workspace: provenance.
      scope: b.scope,
      broker: broker.provider,
      // An MCP connection is its OWN kind. Storing it as `oauth` was already loose; once it
      // carries a `secret_enc` — which only `secret` was ever meant to have — it is a lie that
      // anything reasoning about `kind` will act on.
      //
      // `base_url` carries the server URL for DISPLAY. The URL also lives inside broker_ref,
      // which is where routing reads it — but a ref is an opaque routing token, and a Sources row
      // that cannot say WHICH server you connected is not much of a Sources row.
      ...(b.mcp_url ? { kind: "mcp" as const, base_url: b.mcp_url.replace(/\/+$/, "") } : {}),
      toolkit: b.toolkit,
      broker_ref: link.ref,
      // Write-only, exactly as `kind: "secret"` stores a pasted key: encrypted at rest, spent
      // server-side by the tool proxy, and absent from `present()` so no role and no minted
      // token can ever read it back.
      ...(b.mcp_url && b.mcp_secret && deps.encryptionKey
        ? { secret_enc: encryptSecret(b.mcp_secret, deps.encryptionKey) }
        : {}),
      scopes_label: b.scopes_label ?? (b.mcp_secret ? `…${b.mcp_secret.slice(-4)}` : null),
      status: link.status,
    })
    // The auth URL rides this response (empty for the local broker's auto-authorized case).
    // `reason` rides it too when the row is waiting on OAuth, so the client can go straight to
    // "Sign in" instead of showing a connection that looks broken.
    return c.json(
      {
        ...present(rec),
        connect_url: link.url,
        ...(awaitingAuth ? { reason: "auth_required" as const } : {}),
      },
      201,
    )
  })

  app.delete("/v1/connections/:id", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const cn = await meta.getConnection(c.req.param("id"))
    if (!cn || cn.org_id !== org) return fail(c, 404, "not found")
    // Personal: the owner may revoke their own; anyone else's needs manage.
    // Workspace: admin-managed — always manage, even for whoever added it.
    if (cn.scope === "workspace" || cn.user_id !== me.id) {
      const gate = await requireWorkspace(c, "manage")
      if (gate instanceof Response) return gate
    }
    // Only a broker-backed connection has a vendor side to revoke. For every direct kind
    // the status flip IS the revocation (the tool proxy refuses non-active rows) — and
    // for the install-backed ones it MUST be: broker_ref is an installation id, not a
    // broker ref, and removing an agent's access must never uninstall the integration
    // the workspace uses for everything else.
    // `mcp` joins the direct kinds here for the same reason they are here: there is no vendor
    // account behind it, so the status flip IS the revocation. Asking a plan broker to revoke an
    // `mcp:` ref would reach the wrong vendor, or (with no plan) a broker that refuses.
    if (!isDirect(cn.kind) && cn.kind !== "mcp") {
      const broker = await brokerFor(meta, org, cn.user_id, deps.encryptionKey, deps.allowEchoStub)
      try {
        await broker.revoke(cn.broker_ref)
      } catch {
        // Best-effort external revoke; the local status still flips to revoked.
      }
    }
    await meta.setConnectionStatus(cn.id, org, "revoked")
    return c.body(null, 204)
  })

  return app
}
