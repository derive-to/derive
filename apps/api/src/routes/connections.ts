import { type ConnectionRecord, newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { brokerFor } from "../lib/broker"
import { encryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

// WO3 — connected external accounts (Sources). Connect once (OAuth via the broker), then
// instructions name the tool in plain language. Two scopes: "personal" (act-as-me — bound to
// the caller, only they may attach it, dies with their membership) and "workspace" (org
// infrastructure — admin-managed, survives the adder leaving; user_id is provenance only).
// A hosted run sees the tools of its bound connections only. The BYO path never touches
// these. broker_ref is the broker-side connected-account id.

// Explicit allowlist — secret_enc must NEVER ride any response, on any route, at any
// role, including the minted dkapi_ REST bearer. Write-only is the whole contract.
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
        toolkit: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "toolkit must be a lowercase slug"),
        scopes_label: z.string().max(200).optional(),
        // "personal" (default) = the caller's own account. "workspace" = org
        // infrastructure — requires manage, because whoever can add a workspace
        // credential decides what every context bound to it can reach.
        scope: z.enum(["personal", "workspace"]).default("personal"),
        // "oauth" (default) = broker round trip. "secret" = paste an API key or
        // bearer token: stored encrypted, spent only server-side, never returned.
        kind: z.enum(["oauth", "secret"]).default("oauth"),
        // kind "secret" only:
        secret: z.string().min(8).max(4096).optional(),
        base_url: z.string().url().max(500).optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    if (b.scope === "workspace") {
      const gate = await requireWorkspace(c, "manage")
      if (gate instanceof Response) return gate
    }
    if (b.kind === "secret") {
      if (!b.secret || !b.base_url)
        return fail(c, 400, "a secret connection needs `secret` and `base_url`")
      if (!b.base_url.startsWith("https://") && !b.base_url.startsWith("http://localhost"))
        return fail(c, 400, "base_url must be https (or http://localhost for dev)")
      if (!deps.encryptionKey)
        return fail(c, 400, "secret connections need an encryption key configured")
      const rec = await meta.createConnection({
        id: newId("conn"),
        org_id: org,
        user_id: me.id,
        scope: b.scope,
        kind: "secret",
        secret_enc: encryptSecret(b.secret, deps.encryptionKey),
        // Normalized without a trailing slash so tool-call joins are predictable.
        base_url: b.base_url.replace(/\/+$/, ""),
        broker: "none", // no vendor: the tool proxy spends this credential itself
        toolkit: b.toolkit,
        broker_ref: `secret:${newId("sref")}`,
        // Display hint only — the last 4 characters, never the credential.
        scopes_label: b.scopes_label ?? `…${b.secret.slice(-4)}`,
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
    // A secret connection has no vendor side to revoke — flipping the status is the
    // whole revocation (the tool proxy refuses non-active rows).
    if (cn.kind !== "secret") {
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
