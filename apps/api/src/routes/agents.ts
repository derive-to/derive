import { randomUUID } from "node:crypto"
import { type AgentRecord, newId, type Role } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

/** Agent registry (Admin-managed) + the agent's pull inbox of @mentions. The Agent +
 *  ConnectedAgent response schemas are the single source for the web client's types
 *  (generated from the OpenAPI spec). The agent inbox endpoints (bearer-authed, consumed
 *  by agents not the web UI) stay plain routes. */
export const agentRoutes = (ctx: AppContext) => {
  const { meta, agentFor, privateOwnerId, requireUser, requireWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const agentJson = (a: AgentRecord, ownerLend = false) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    hosted: a.hosted === 1,
    managed: a.managed === 1,
    created_by: a.created_by,
    owner_lend: ownerLend,
    created_at: a.created_at,
  })

  // A workspace-registered agent, without its token hash.
  const Agent = z
    .object({
      id: z.string(),
      name: z.string(),
      role: z
        .enum(["viewer", "commenter", "editor", "owner"])
        .describe(
          "Permission level; commenter proposes only, editor can write, owner never allowed",
        ),
      hosted: z
        .boolean()
        .describe(
          "Served by Derive's managed executor. Hosting changes where the agent runs, never its principal or cap.",
        ),
      managed: z
        .boolean()
        .describe(
          "Auto-minted for one context at creation — the context's Derive access, not a user-named persona. Hidden from the roster UI.",
        ),
      created_by: z
        .string()
        .nullable()
        .describe("The user who registered the agent — who it publishes and bills on behalf of."),
      owner_lend: z
        .boolean()
        .describe(
          "When true, this agent may bill its OWNER's own model plan as a fallback (initiator -> owner -> pool). Only the owner toggles it; default off.",
        ),
      created_at: z.string(),
    })
    .openapi("Agent")

  // An OAuth agent the signed-in user authorized to act on their behalf.
  const ConnectedAgent = z
    .object({
      clientId: z
        .string()
        .describe("OAuth client id of the authorized agent (e.g. an MCP client like Claude)"),
      clientName: z.string(),
      scopes: z.array(z.string()).describe("The OAuth scopes this agent was granted"),
      grantedAt: z.string(),
    })
    .openapi("ConnectedAgent")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/agents",
      tags: ["Agents"],
      summary: "List the workspace's registered agents (Admin only).",
      responses: {
        200: {
          description: "The workspace's agents.",
          content: { "application/json": { schema: z.object({ agents: z.array(Agent) }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const agents = await meta.listAgents(org)
      const lent = new Set((await meta.getOrgSettings(org)).ownerLendAgents ?? [])
      return c.json({ agents: agents.map((a) => agentJson(a, lent.has(a.id))) })
    },
  )

  // Create an agent + mint its token. The token is returned ONCE here; only its
  // SHA-256 hash is stored, so a database leak can't expose usable credentials
  // (the token is high-entropy random, so a plain hash is sufficient — no salt
  // or slow KDF needed). Default role commenter (propose-only); editor is
  // opt-in. Owner is never allowed for an agent.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/agents",
      tags: ["Agents"],
      summary: "Register an agent and mint its token (returned once).",
      responses: {
        201: {
          description: "The created agent, plus its bearer token (shown only here).",
          content: { "application/json": { schema: Agent.extend({ token: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          name: z.string().refine((s) => s.trim() !== "", "name required"),
          role: z.unknown().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const name = b.name.trim()
      const role: Role =
        b.role === "viewer" || b.role === "commenter" || b.role === "editor" ? b.role : "commenter"
      const token = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
      try {
        const agent = await meta.createAgent({
          id: newId("ag"),
          org_id: org,
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
        return bail(fail(c, 409, "an agent with that name already exists"))
      }
    },
  )

  // Flip whether Derive's managed executor serves this agent. Deliberately the ONLY
  // mutable field here: name/role changes stay recreate-the-agent, so hosting can't
  // become a side door for privilege edits.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/agents/{id}",
      tags: ["Agents"],
      summary: "Update an agent's hosted flag (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated agent.",
          content: { "application/json": { schema: Agent } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(c, z.object({ hosted: z.boolean() }))
      if (b instanceof Response) return bail(b)
      // Scoped to (id, org) like delete, so an Admin can't flip another workspace's agent.
      const updated = await meta.setAgentHosted(c.req.param("id"), org, b.hosted ? 1 : 0)
      if (!updated) return bail(fail(c, 404, "agent not found"))
      return c.json(agentJson(updated))
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/agents/{id}/rotate",
      tags: ["Agents"],
      summary: "Rotate an agent's token (Admin only) — the old bearer dies at once.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The agent, plus its NEW bearer token (shown only here).",
          content: { "application/json": { schema: Agent.extend({ token: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      // Same mint shape as registration; only the hash is stored. Identity, role,
      // hosting, and attribution are untouched — rotation is a credential event,
      // never an identity event.
      const token = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
      const rotated = await meta.rotateAgentToken(c.req.param("id"), org, sha256(token))
      if (!rotated) return bail(fail(c, 404, "agent not found"))
      return c.json({ ...agentJson(rotated), token })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/agents/{id}",
      tags: ["Agents"],
      summary: "Delete an agent (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The agent was deleted." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      // Scope the delete to the caller's workspace: deleteAgent is keyed by
      // (id, org) so an Admin can't delete another workspace's agent by id.
      await meta.deleteAgent(c.req.param("id"), org)
      return c.body(null, 204)
    },
  )

  // ---- Connected agents (delegation provenance + revocation) --------------
  // The OAuth agents the SIGNED-IN USER has authorized to act on their behalf (MCP clients
  // like Claude that went through the browser consent) — distinct from workspace-registered
  // agents above. Listing + one-tap revocation make delegation legible and reversible: the
  // human can always see what may act as them and cut it off. Scoped to the caller's own
  // grants, never another user's.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/me/connected-agents",
      tags: ["Agents"],
      summary: "List the OAuth agents the signed-in user authorized to act on their behalf.",
      responses: {
        200: {
          description: "The caller's connected agents.",
          content: {
            "application/json": { schema: z.object({ agents: z.array(ConnectedAgent) }) },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      return c.json({ agents: await meta.listUserGrants(me.id) })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/me/connected-agents/{clientId}",
      tags: ["Agents"],
      summary: "Revoke a connected agent's authorization.",
      request: { params: z.object({ clientId: z.string() }) },
      responses: { 204: { description: "The grant was revoked (idempotent)." } },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      await meta.revokeUserGrant(me.id, c.req.param("clientId"))
      return c.body(null, 204)
    },
  )

  // The agent's pull inbox: mentions awaiting a response. Auth = the agent's own bearer
  // token; consumed by agents, not the web UI — plain routes (not in the spec).
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
