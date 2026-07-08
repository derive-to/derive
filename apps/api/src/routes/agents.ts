import { randomUUID } from "node:crypto"
import { type AgentRecord, newId, type Role } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"
import { fail, readJson } from "../lib/http"

/** Agent registry (Admin-managed) + the agent's pull inbox of @mentions. */
export const agentRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, agentFor, privateOwnerId, requireUser, workspaceCan } = ctx
  const app = new Hono()

  const agentJson = (a: AgentRecord) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    created_at: a.created_at,
  })

  app.get("/v1/agents", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const agents = await meta.listAgents(await activeWorkspace(c))
    return c.json({ agents: agents.map(agentJson) })
  })

  // Create an agent + mint its token. The token is returned ONCE here; only its
  // SHA-256 hash is stored, so a database leak can't expose usable credentials
  // (the token is high-entropy random, so a plain hash is sufficient — no salt
  // or slow KDF needed). Default role commenter (propose-only); editor is
  // opt-in. Owner is never allowed for an agent.
  app.post("/v1/agents", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        name: z.string().refine((s) => s.trim() !== "", "name required"),
        role: z.unknown().optional(),
      }),
    )
    if (b instanceof Response) return b
    const name = b.name.trim()
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
        // The agent publishes on behalf of whoever registered it: their id keys
        // attribution (author_id) and ownership (the owner-member row) at publish.
        // privateOwnerId so a `derive context push` registration (an OAuth agent
        // with the manage scope) attributes to the GRANTOR, not to nobody.
        created_by: (await privateOwnerId(c)) ?? null,
      })
      // The only place the raw token is ever exposed.
      return c.json({ ...agentJson(agent), token }, 201)
    } catch {
      return fail(c, 409, "an agent with that name already exists")
    }
  })

  app.delete("/v1/agents/:id", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    // Scope the delete to the caller's workspace: deleteAgent is keyed by
    // (id, org) so an Admin can't delete another workspace's agent by id.
    await meta.deleteAgent(c.req.param("id"), await activeWorkspace(c))
    return c.body(null, 204)
  })

  // ---- Connected agents (delegation provenance + revocation) --------------
  // The OAuth agents the SIGNED-IN USER has authorized to act on their behalf (MCP clients
  // like Claude that went through the browser consent) — distinct from workspace-registered
  // agents above. Listing + one-tap revocation make delegation legible and reversible: the
  // human can always see what may act as them and cut it off. Scoped to the caller's own
  // grants, never another user's.
  app.get("/v1/me/connected-agents", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    return c.json({ agents: await meta.listUserGrants(me.id) })
  })

  app.delete("/v1/me/connected-agents/:clientId", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    await meta.revokeUserGrant(me.id, c.req.param("clientId"))
    return c.body(null, 204)
  })

  // The agent's pull inbox: mentions awaiting a response. Auth = the agent's
  // own bearer token. The agent reads context via the normal read endpoints,
  // proposes/replies with this same token, then acks.
  app.get("/v1/agent/inbox", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
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
    if (!agent) return fail(c, 401, "agent token required")
    const ok = await meta.ackAgentMention(agent.id, c.req.param("id"))
    return ok ? c.json({ ok: true }) : fail(c, 404, "not found")
  })

  return app
}
