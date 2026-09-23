import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { manageableContext, runnableContext } from "../lib/context-access"
import { fail, readJson } from "../lib/http"

export const contextRuntimeModelBindingRoutes = (ctx: AppContext) => {
  const app = new Hono()
  app.get("/v1/contexts/:id/runtime/model-connection", async (c) => {
    c.header("Cache-Control", "no-store")
    const context = await runnableContext(ctx, c)
    if (context instanceof Response) return context
    const binding = await ctx.meta.getRuntimeModelBinding(context.id, context.org_id)
    const connection = binding?.model_connection_id
      ? await ctx.meta.getRuntimeModelConnection(binding.model_connection_id, context.org_id)
      : null
    return c.json({
      revision: binding?.revision ?? null,
      connection: connection && {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        revoked: !!connection.revoked_at,
        can_manage: connection.created_by === (await ctx.managementPrincipal(c)),
      },
    })
  })
  app.put("/v1/contexts/:id/runtime/model-connection", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const owner = await ctx.managementPrincipal(c)
    if (!owner) return fail(c, 403, "A model account owner is required")
    const body = await readJson(
      c,
      z.object({
        connection_id: z.string().min(1).max(64).nullable(),
        revision: z.number().int().nonnegative().nullable(),
      }),
    )
    if (body instanceof Response) return body
    if (body.connection_id) {
      if (!ctx.deps.runtime?.managed?.workspaceIds.has(context.org_id))
        return fail(c, 404, "not found")
      const connection = await ctx.meta.getRuntimeModelConnection(
        body.connection_id,
        context.org_id,
      )
      if (!connection || connection.created_by !== owner) return fail(c, 404, "not found")
      if (connection.revoked_at) return fail(c, 409, "This model account has been disconnected")
      if (connection.api_url !== ctx.deps.runtime.apiUrl)
        return fail(c, 409, "This model account belongs to a different service")
    }
    const binding = await ctx.meta.saveRuntimeModelBinding({
      contextId: context.id,
      orgId: context.org_id,
      ownerId: owner,
      connectionId: body.connection_id,
      revision: body.revision,
      at: new Date().toISOString(),
    })
    if (!binding)
      return fail(c, 409, "Model selection changed or is unavailable; reload before saving")
    ctx.deps.pokeRuntime?.()
    return c.json({ revision: binding.revision, connection_id: binding.model_connection_id })
  })
  return app
}
