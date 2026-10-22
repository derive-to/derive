import type { AgentMemberRole, AgentRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { canManageAgent } from "../lib/job-policy"
import { resolveUserRef } from "../lib/resolve-user"
import { ArtifactMember } from "../schemas"

/** Who an agent is shared with: the same people-and-roles roster an artifact or collection
 *  has, over members of its workspace only. An `editor` may ask it; an `owner` may also manage
 *  it. Its creator always owns it and is listed first without a row. Whether everyone in the
 *  workspace may ask is the agent's `ask_policy`, set with the rest of its definition. */
export function agentMemberRoutes(ctx: AppContext) {
  const app = new OpenAPIHono()
  const { meta } = ctx
  const Members = z.object({ members: z.array(ArtifactMember) })
  const MemberRole = z.enum(["editor", "owner"])

  /** The agent, if the caller may change who it is shared with. An agent that runs on its
   *  creator's account changes hands only by the creator's: nobody else widens who spends it. */
  const sharedBy = async (c: Parameters<typeof ctx.requireWorkspace>[0]) => {
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const who = await ctx.actingHuman(c)
    if (!who) return fail(c, 401, "unauthenticated")
    const agent = await meta.getAgent(c.req.param("id") ?? "")
    if (!agent || agent.org_id !== org || !(await canManageAgent(meta, agent, who.id)))
      return fail(c, 404, "agent not found")
    if (agent.spend_policy === "creator" && who.id !== agent.created_by)
      return fail(c, 403, "this agent runs on its creator's account: only they can share it")
    return agent
  }

  const roster = async (agent: AgentRecord) => {
    const rows = await meta.listAgentMembers(agent.id, agent.org_id)
    const ids = [...(agent.created_by ? [agent.created_by] : []), ...rows.map((r) => r.user_id)]
    const users = new Map((await meta.getUsers(ids)).map((u) => [u.id, u]))
    const json = (id: string, role: AgentMemberRole) => ({
      user_id: id,
      handle: users.get(id)?.username ?? null,
      name: users.get(id)?.name ?? null,
      role,
    })
    return [
      ...(agent.created_by ? [json(agent.created_by, "owner")] : []),
      ...rows.map((r) => json(r.user_id, r.role)),
    ]
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/agents/{id}/members",
      tags: ["Agents"],
      summary: "The people an agent is shared with, its creator first.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "The roster.", content: { "application/json": { schema: Members } } },
      },
    }),
    async (c) => {
      const org = await ctx.requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const agent = await meta.getAgent(c.req.param("id"))
      if (!agent || agent.org_id !== org) return bail(fail(c, 404, "agent not found"))
      return c.json({ members: await roster(agent) })
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/agents/{id}/members",
      tags: ["Agents"],
      summary: "Share an agent with a workspace member, or change their role.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "The roster.", content: { "application/json": { schema: Members } } },
      },
    }),
    async (c) => {
      const agent = await sharedBy(c)
      if (agent instanceof Response) return bail(agent)
      const b = await readJson(
        c,
        z.object({ user: z.string().trim().min(1).max(320), role: MemberRole }),
      )
      if (b instanceof Response) return bail(b)
      const id = await resolveUserRef(meta, b.user)
      if (!id || !(await meta.getMembership(agent.org_id, id).catch(() => null)))
        return bail(fail(c, 404, "no member of this workspace with that username or email"))
      if (id === agent.created_by) return bail(fail(c, 409, "an agent's creator always owns it"))
      await meta.setAgentMember(agent.id, agent.org_id, id, b.role)
      return c.json({ members: await roster(agent) })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/agents/{id}/members/{userId}",
      tags: ["Agents"],
      summary: "Stop sharing an agent with someone.",
      request: { params: z.object({ id: z.string(), userId: z.string() }) },
      responses: {
        200: { description: "The roster.", content: { "application/json": { schema: Members } } },
      },
    }),
    async (c) => {
      const agent = await sharedBy(c)
      if (agent instanceof Response) return bail(agent)
      await meta.setAgentMember(agent.id, agent.org_id, c.req.param("userId"), null)
      return c.json({ members: await roster(agent) })
    },
  )

  return app
}
