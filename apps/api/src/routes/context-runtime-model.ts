import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { manageableContext } from "../lib/context-access"
import { fail, readJson } from "../lib/http"
import { modelConnections, modelHarness, modelSignIn } from "../lib/ortam-client"
import { managedRuntimeClient } from "../lib/runtime-controller"

const provider = z.enum(["codex", "claude-code"])

export const contextRuntimeModelRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const authority = async (c: Parameters<typeof manageableContext>[1]) => {
    c.header("Cache-Control", "no-store")
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (context.import_source) return fail(c, 400, "Imported Contexts cannot run agents")
    const config = ctx.deps.runtime
    if (!config?.managed?.workspaceIds.has(context.org_id)) return fail(c, 404, "not found")
    const client = managedRuntimeClient(config, context.org_id, context.id, ctx.deps.runtimeFetch)
    const identity = await client.authenticate()
    return { client, identity }
  }
  // All endpoints gate through manageableContext before accessing the service key.
  app.get("/v1/contexts/:id/runtime/model", async (c) => {
    const auth = await authority(c)
    if (auth instanceof Response) return auth
    return c.json(modelConnections.parse(await auth.client.request("/agents", auth.identity)))
  })
  app.post("/v1/contexts/:id/runtime/model/sign-in", async (c) => {
    const auth = await authority(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c, z.object({ provider }))
    if (body instanceof Response) return body
    return c.json(
      modelSignIn.parse(
        await auth.client.request(
          `/agents/${modelHarness(body.provider)}/sign-in`,
          auth.identity,
          "POST",
        ),
      ),
      202,
    )
  })
  app.get("/v1/contexts/:id/runtime/model/sign-in/:attempt", async (c) => {
    const auth = await authority(c)
    if (auth instanceof Response) return auth
    return c.json(
      modelSignIn.parse(
        await auth.client.request(
          `/agent-sign-in-attempts/${encodeURIComponent(c.req.param("attempt"))}`,
          auth.identity,
        ),
      ),
    )
  })
  app.post("/v1/contexts/:id/runtime/model/sign-in/:attempt/complete", async (c) => {
    const auth = await authority(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c, z.object({ code: z.string().trim().min(1).max(4096) }))
    if (body instanceof Response) return body
    return c.json(
      await auth.client.completeModelSignIn(c.req.param("attempt"), body.code, auth.identity),
    )
  })
  app.post("/v1/contexts/:id/runtime/model/sign-in/:attempt/cancel", async (c) => {
    const auth = await authority(c)
    if (auth instanceof Response) return auth
    return c.json(
      modelSignIn.parse(
        await auth.client.request(
          `/agent-sign-in-attempts/${encodeURIComponent(c.req.param("attempt"))}/cancel`,
          auth.identity,
          "POST",
        ),
      ),
    )
  })
  app.delete("/v1/contexts/:id/runtime/model/:provider", async (c) => {
    const auth = await authority(c)
    if (auth instanceof Response) return auth
    const parsed = provider.safeParse(c.req.param("provider"))
    if (!parsed.success) return fail(c, 400, "Unknown agent")
    await auth.client.request(`/agents/${modelHarness(parsed.data)}`, auth.identity, "DELETE")
    return c.json({ disconnected: true })
  })
  return app
}
