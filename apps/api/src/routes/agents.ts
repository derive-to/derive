import { randomUUID } from "node:crypto"
import { type AgentRecord, newId, type Role } from "@dock/core"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"

/** Agent registry (Admin-managed) + the agent's pull inbox of @mentions. */
export const agentRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, agentFor, workspaceCan } = ctx
  const app = new Hono()

  const agentJson = (a: AgentRecord) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    created_at: a.created_at,
  })

  app.get("/v1/agents", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const agents = await meta.listAgents(await activeWorkspace(c))
    return c.json({ agents: agents.map(agentJson) })
  })

  // Create an agent + mint its token. The token is returned ONCE here; only its
  // SHA-256 hash is stored, so a database leak can't expose usable credentials
  // (the token is high-entropy random, so a plain hash is sufficient — no salt
  // or slow KDF needed). Default role commenter (propose-only); editor is
  // opt-in. Owner is never allowed for an agent.
  app.post("/v1/agents", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown; role?: unknown }
    const name = typeof b.name === "string" ? b.name.trim() : ""
    if (!name) return c.json({ error: "name required" }, 400)
    const role: Role =
      b.role === "viewer" || b.role === "commenter" || b.role === "editor" ? b.role : "commenter"
    const token = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
    try {
      const agent = await meta.createAgent({
        id: newId("ag"),
        org_id: await activeWorkspace(c),
        name,
        token: sha256(token),
        role,
      })
      // The only place the raw token is ever exposed.
      return c.json({ ...agentJson(agent), token }, 201)
    } catch {
      return c.json({ error: "an agent with that name already exists" }, 409)
    }
  })

  app.delete("/v1/agents/:id", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.deleteAgent(c.req.param("id"))
    return c.body(null, 204)
  })

  // The agent's pull inbox: mentions awaiting a response. Auth = the agent's
  // own bearer token. The agent reads context via the normal read endpoints,
  // proposes/replies with this same token, then acks.
  app.get("/v1/agent/inbox", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return c.json({ error: "agent token required" }, 401)
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20))
    const mentions = await meta.listPendingAgentMentions(agent.id, limit)
    return c.json({
      agent: agentJson(agent),
      mentions: mentions.map((m) => ({
        id: m.id,
        artifact: m.artifact_short_id,
        comment_id: m.comment_id,
        thread_id: m.thread_id,
        body: m.body,
        author: m.author,
        created_at: m.created_at,
      })),
    })
  })

  app.post("/v1/agent/mentions/:id/ack", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return c.json({ error: "agent token required" }, 401)
    const ok = await meta.ackAgentMention(agent.id, c.req.param("id"))
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
  })

  return app
}
