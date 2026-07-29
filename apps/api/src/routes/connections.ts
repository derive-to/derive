import { McpBroker } from "@derive/broker"
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
const installMissing: Record<"github_app" | "slack", string> = {
  github_app: "connect the GitHub App first (Settings → Sync), then add it as a connection",
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
        // Ignored for github_app/slack, which name themselves.
        toolkit: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "toolkit must be a lowercase slug")
          .optional(),
        scopes_label: z.string().max(200).optional(),
        /** Connect an MCP server directly: no vendor account, no OAuth round trip, and it works
         *  in a workspace with NO broker plan — which is every workspace today. Routes on its own
         *  URL rather than the workspace's plan, so it is orthogonal to `kind` above (an MCP
         *  server still authenticates however it chooses; Derive holds no credential for it). */
        mcp_url: z.string().url().max(2000).optional(),
        // "personal" (default) = the caller's own account. "workspace" = org
        // infrastructure — requires manage, because whoever can add a workspace
        // credential decides what every context bound to it can reach.
        scope: z.enum(["personal", "workspace"]).default("personal"),
        // How it authenticates. "oauth" (default) = broker round trip. "secret" = paste
        // a key. "github_app"/"slack" = give an install Derive ALREADY holds a tool
        // surface; they store no credential of their own.
        kind: z.enum(["oauth", "secret", "github_app", "slack"]).default("oauth"),
        // kind "secret" only:
        secret: z.string().min(8).max(4096).optional(),
        base_url: z.string().url().max(500).optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    // An install-backed connection is org infrastructure by construction — the install
    // belongs to the workspace, not to whoever happens to wire it up.
    const scope = b.kind === "github_app" || b.kind === "slack" ? "workspace" : b.scope
    if (scope === "workspace") {
      const gate = await requireWorkspace(c, "manage")
      if (gate instanceof Response) return gate
    }
    if (b.kind === "github_app" || b.kind === "slack") {
      // Point at what the workspace already connected. Nothing is created here and no
      // OAuth is started — if the install is missing, the integration's own flow is
      // where you go. A second App install on the same workspace is a real (if rare)
      // case; the first is used until someone asks to choose.
      const install =
        b.kind === "slack"
          ? await meta.getSlackInstall(org).then((i) => i && { ref: i.team_id, label: i.team_name })
          : await meta
              .listGithubInstallations(org)
              .then(([i]) => i && { ref: i.installation_id, label: i.account_login })
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
        toolkit: b.kind === "slack" ? "slack" : "github",
        broker_ref: install.ref,
        base_url: b.kind === "slack" ? "https://slack.com/api" : "https://api.github.com",
        scopes_label: b.scopes_label ?? install.label,
        status: "active",
      })
      return c.json(present(rec), 201)
    }
    if (!b.toolkit) return fail(c, 400, "toolkit is required")
    if (b.kind === "secret") {
      if (!b.secret || !b.base_url)
        return fail(c, 400, "a secret connection needs `secret` and `base_url`")
      if (!b.base_url.startsWith("https://") && !b.base_url.startsWith("http://localhost"))
        return fail(c, 400, "base_url must be https (or http://localhost for dev)")
      if (!deps.encryptionKey) return fail(c, 502, "secret connections need an encryption key")
      const rec = await meta.createConnection({
        id: newId("conn"),
        org_id: org,
        user_id: me.id,
        scope: b.scope,
        kind: "secret",
        secret_enc: encryptSecret(b.secret, deps.encryptionKey),
        // Stored without a trailing slash; executeSecretTool adds one when it resolves a path.
        base_url: b.base_url.replace(/\/+$/, ""),
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
    if (!b.toolkit) return bail(fail(c, 400, "toolkit is required"))
    // An MCP connection routes on its OWN URL rather than the workspace's broker plan, and is
    // built per request (it holds only a session map, no credential) so nothing is cached across
    // tenants. Everything else resolves a plan: a workspace connection from the pool (it must not
    // ride — and die with — one member's personal plan), a personal one from the caller.
    const broker = b.mcp_url
      ? new McpBroker()
      : await brokerFor(meta, org, b.scope === "workspace" ? null : me.id, deps.encryptionKey)
    const link = await broker.connect({
      orgId: org,
      userId: me.id,
      toolkit: b.mcp_url ?? b.toolkit,
    })
    const rec = await meta.createConnection({
      id: newId("conn"),
      org_id: org,
      user_id: me.id, // personal: the owner (never falls back). workspace: provenance.
      scope: b.scope,
      broker: broker.provider,
      toolkit: b.toolkit,
      broker_ref: link.ref,
      scopes_label: b.scopes_label ?? null,
      status: link.status,
    })
    // The auth URL rides this response (empty for the local broker's auto-authorized case).
    return c.json({ ...present(rec), connect_url: link.url }, 201)
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
    if (!isDirect(cn.kind)) {
      const broker = await brokerFor(meta, org, cn.user_id, deps.encryptionKey)
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
