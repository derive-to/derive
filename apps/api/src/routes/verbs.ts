import { newId, type VerbRecord } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { invokeVerb, verbConnectionIds } from "../lib/verbs"

// WO5 — owner-authored actions on an artifact. A viewer INVOKES a verb; they never type an
// instruction at it. The verb owner writes the instruction template; the run bills to the
// owner, records the invoker, and starts propose-gated (promoted to direct per verb).

const present = (v: VerbRecord) => {
  let params: unknown = null
  if (v.params_schema) {
    try {
      params = JSON.parse(v.params_schema)
    } catch {}
  }
  return {
    id: v.id,
    org_id: v.org_id,
    artifact_id: v.artifact_id,
    name: v.name,
    instruction_template: v.instruction_template,
    created_by: v.created_by,
    agent_id: v.agent_id,
    params_schema: params,
    connection_ids: verbConnectionIds(v),
    gate: v.gate,
    audience: v.audience,
    enabled: v.enabled === 1,
    created_at: v.created_at,
  }
}

export const verbRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireWorkspace } = ctx
  const app = new Hono()

  app.get("/v1/artifacts/:shortId/verbs", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art || art.org_id !== org) return fail(c, 404, "artifact not found")
    const verbs = await meta.listVerbsForArtifact(art.id)
    return c.json({ verbs: verbs.map(present) })
  })

  app.post("/v1/artifacts/:shortId/verbs", async (c) => {
    const org = await requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art || art.org_id !== org) return fail(c, 404, "artifact not found")
    const b = await readJson(
      c,
      z.object({
        name: z.string().min(1).max(80),
        instruction: z.string().min(1).max(4000),
        agentId: z.string(),
        params_schema: z.record(z.string(), z.unknown()).optional(),
        connection_ids: z.array(z.string().max(64)).max(20).optional(),
        gate: z.enum(["propose", "direct"]).default("propose"),
        audience: z.enum(["owner", "members"]).default("members"),
      }),
    )
    if (b instanceof Response) return bail(b)
    // The agent must belong to this workspace — never an id from another tenant.
    const agents = await meta.listAgents(org)
    if (!agents.some((a) => a.id === b.agentId))
      return bail(fail(c, 400, "agent must be in this workspace"))
    // Bound connections must be the creator's OWN, in this org (identity + least privilege).
    if (b.connection_ids?.length) {
      const conns = await meta.getConnectionsByIds(b.connection_ids)
      const ok = conns.every((cn) => cn.org_id === org && cn.user_id === me.id)
      if (!ok || conns.length !== b.connection_ids.length)
        return bail(fail(c, 400, "connections must be your own in this workspace"))
    }
    const rec = await meta.createVerb({
      id: newId("verb"),
      org_id: org,
      artifact_id: art.id,
      name: b.name,
      instruction_template: b.instruction,
      created_by: me.id,
      agent_id: b.agentId,
      params_schema: b.params_schema ? JSON.stringify(b.params_schema) : null,
      connection_ids: b.connection_ids ? JSON.stringify(b.connection_ids) : null,
      gate: b.gate,
      audience: b.audience,
    })
    return c.json(present(rec), 201)
  })

  app.patch("/v1/verbs/:id", async (c) => {
    const org = await requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const v = await meta.getVerb(c.req.param("id"))
    if (!v || v.org_id !== org) return fail(c, 404, "not found")
    const b = await readJson(
      c,
      z.object({
        name: z.string().min(1).max(80).optional(),
        instruction: z.string().min(1).max(4000).optional(),
        gate: z.enum(["propose", "direct"]).optional(),
        audience: z.enum(["owner", "members"]).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    if (b instanceof Response) return bail(b)
    // Promoting a verb to publish-direct is the OWNER's call alone.
    if (b.gate === "direct" && v.created_by !== me.id)
      return fail(c, 403, "only the verb owner can promote it to publish directly")
    const updated = await meta.updateVerb(v.id, org, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.instruction !== undefined ? { instruction_template: b.instruction } : {}),
      ...(b.gate !== undefined ? { gate: b.gate } : {}),
      ...(b.audience !== undefined ? { audience: b.audience } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}),
    })
    return updated ? c.json(present(updated)) : fail(c, 404, "not found")
  })

  app.delete("/v1/verbs/:id", async (c) => {
    const org = await requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const v = await meta.getVerb(c.req.param("id"))
    if (!v || v.org_id !== org) return fail(c, 404, "not found")
    await meta.deleteVerb(v.id, org)
    return c.body(null, 204)
  })

  // Invoke a verb: a viewer (or an agent) clicks it. Audience + params are enforced inside
  // invokeVerb; the run bills to the owner and lands per the verb's gate.
  app.post("/v1/verbs/:id/invoke", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const v = await meta.getVerb(c.req.param("id"))
    if (!v || v.org_id !== org) return fail(c, 404, "not found")
    // The HTTP surface is the human click. An agent invokes the SAME verb over MCP (WO8),
    // which calls invokeVerb directly with its on-behalf-of identity.
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(c, z.object({ params: z.record(z.string(), z.unknown()).optional() }))
    if (b instanceof Response) return bail(b)
    const out = await invokeVerb(meta, v, me.id, `user:${me.id}`, b.params)
    return out.ok
      ? c.json({ id: out.runId, status: out.status }, 201)
      : fail(c, out.code, out.error)
  })

  return app
}
