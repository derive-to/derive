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

// Where the machineless lane may send a pasted credential: https anywhere, or plain http ONLY
// to the loopback host for local development. Compared on the parsed hostname, because a
// string prefix test on "http://localhost" also accepts http://localhost.evil.com — a
// cleartext bearer sent to somebody else's server.
const isAllowedBase = (raw: string): boolean => {
  try {
    const u = new URL(raw)
    if (u.protocol === "https:") return true
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")
  } catch {
    return false
  }
}

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
        // nullish, not optional: GET /v1/connections renders an absent host as `base_url: null`,
        // and round-tripping that object straight back into this route is the obvious client
        // pattern — it should not 400 on the shape we just handed out.
        base_url: z.string().url().max(500).nullish(),
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
      if (b.base_url && !isAllowedBase(b.base_url))
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
    // A workspace connection resolves its broker plan from the pool (it must not ride —
    // and die with — one member's personal broker plan); a personal one from the caller.
    const broker = await brokerFor(
      meta,
      org,
      b.scope === "workspace" ? null : me.id,
      deps.encryptionKey,
    )
    const link = await broker.connect({ orgId: org, userId: me.id, toolkit: b.toolkit })
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
