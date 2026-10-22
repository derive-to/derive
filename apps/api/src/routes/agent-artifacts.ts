import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppContext } from "../context"
import { bail, fail } from "../lib/http"
import { agentAccess, agentGrant } from "../lib/job-policy"

/** Pins are explicit agent/document relationships, never inferred from job effects.
 * Permission is checked again on every read: pinning does not share a private document. */
export function agentArtifactRoutes(ctx: AppContext) {
  const app = new OpenAPIHono()
  const Pin = z
    .object({
      short_id: z.string(),
      title: z.string(),
      kind: z.string(),
      version: z.number(),
      updated_at: z.string(),
    })
    .openapi("AgentArtifactPin")
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/agents/{id}/artifacts",
      tags: ["Agents"],
      summary: "Readable documents pinned to an agent, at their latest version.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Pinned documents visible to this caller.",
          content: { "application/json": { schema: z.object({ artifacts: z.array(Pin) }) } },
        },
      },
    }),
    async (c) => {
      const org = await ctx.requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const agent = await ctx.meta.getAgent(c.req.param("id"))
      if (!agent || agent.org_id !== org) return bail(fail(c, 404, "agent not found"))
      const pins = await ctx.meta.listAgentArtifactPins(agent.id, org)
      const artifacts: z.infer<typeof Pin>[] = []
      const records = await ctx.meta.getArtifactsByIds(pins.map((pin) => pin.artifact_id))
      for (const record of records) {
        if (!record || record.org_id !== org || record.archived_at || record.removed_at) continue
        const art = await ctx.requireArtifact(c, "read", { shortId: record.short_id })
        if (art instanceof Response) continue
        artifacts.push({
          short_id: art.short_id,
          title: art.title ?? "Untitled",
          kind: art.kind,
          version: art.current_version,
          updated_at: art.updated_at ?? art.created_at,
        })
      }
      return c.json({ artifacts })
    },
  )
  for (const method of ["put", "delete"] as const) {
    app.openapi(
      createRoute({
        method,
        path: "/v1/agents/{id}/artifacts/{ref}",
        tags: ["Agents"],
        summary: method === "put" ? "Pin a document to an agent." : "Unpin an agent document.",
        request: { params: z.object({ id: z.string(), ref: z.string().min(1).max(64) }) },
        responses: {
          200: {
            description: "Pin updated.",
            content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
          },
        },
      }),
      async (c) => {
        const org = await ctx.requireWorkspace(c, "read")
        if (org instanceof Response) return bail(org)
        const who = await ctx.actingHuman(c)
        if (!who) return bail(fail(c, 401, "unauthenticated"))
        const agent = await ctx.meta.getAgent(c.req.param("id"))
        const member = await ctx.meta.getMembership(org, who.id)
        if (
          !agent ||
          agent.org_id !== org ||
          !agentAccess(
            agent,
            member,
            await ctx.agentFor(c),
            await agentGrant(ctx.meta, agent, who.id),
          ).can_manage
        )
          return bail(fail(c, 404, "agent not found"))
        const art = await ctx.requireArtifact(c, "read", { shortId: c.req.param("ref") })
        if (art instanceof Response) return bail(art)
        if (art.org_id !== org || (method === "put" && (art.archived_at || art.removed_at)))
          return bail(fail(c, 400, "Choose an active artifact in this workspace"))
        await ctx.meta.setAgentArtifactPin(agent.id, org, art.id, method === "put")
        return c.json({ ok: true as const })
      },
    )
  }
  return app
}
