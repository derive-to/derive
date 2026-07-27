import { McpBroker } from "@derive/broker"
import { type ConnectionRecord, newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { brokerFor } from "../lib/broker"
import { bail, fail, readJson } from "../lib/http"

// WO3 — per-user connected external accounts (Sources). Connect once (OAuth via the broker),
// then instructions name the tool in plain language. Always bound to a specific person
// (identity never falls back); a hosted run sees the tools of its bound connections only. The
// BYO path never touches these. broker_ref is the broker-side connected-account id.

const present = (cn: ConnectionRecord) => ({
  id: cn.id,
  org_id: cn.org_id,
  user_id: cn.user_id,
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
    // ?mine=1 scopes to the caller's own connections.
    const scoped = c.req.query("mine") === "1" ? me.id : undefined
    return c.json({ connections: (await meta.listConnections(org, scoped)).map(present) })
  })

  app.post("/v1/connections", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(
      c,
      z.object({
        // A toolkit slug for a vendor broker ("gmail", "stripe"), OR — when `mcp_url` is given —
        // the human label for an MCP server. The URL is a separate field because it is longer
        // than a slug and shaped differently, and conflating them made the validation lie.
        toolkit: z.string().min(1).max(64),
        scopes_label: z.string().max(200).optional(),
        /** Connect an MCP server directly: no vendor account, no OAuth round trip, and it works
         *  in a workspace with no broker plan — which is every workspace today. */
        mcp_url: z.string().url().max(2000).optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    // An MCP connection routes on its own URL rather than the workspace's broker plan. Built
    // per request (it holds only a session map, no credential), so nothing is cached across
    // tenants.
    const broker = b.mcp_url
      ? new McpBroker()
      : await brokerFor(meta, org, me.id, deps.encryptionKey)
    const link = await broker.connect({
      orgId: org,
      userId: me.id,
      toolkit: b.mcp_url ?? b.toolkit,
    })
    const rec = await meta.createConnection({
      id: newId("conn"),
      org_id: org,
      user_id: me.id, // identity NEVER falls back — bound to the caller
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
    // You can revoke your OWN connection; someone else's needs manage.
    if (cn.user_id !== me.id) {
      const gate = await requireWorkspace(c, "manage")
      if (gate instanceof Response) return gate
    }
    const broker = await brokerFor(meta, org, cn.user_id, deps.encryptionKey)
    try {
      await broker.revoke(cn.broker_ref)
    } catch {
      // Best-effort external revoke; the local status still flips to revoked.
    }
    await meta.setConnectionStatus(cn.id, org, "revoked")
    return c.body(null, 204)
  })

  return app
}
