import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { parseConnectionIds } from "../lib/broker"
import { readEnvironmentBindings } from "../lib/context-environment"
import { credentialRevision, credentialView, credentialVisible } from "../lib/credentials"
import { encryptSecret } from "../lib/crypto"
import { fail, readJson } from "../lib/http"

/** Credential management is a view of existing secret connections, not another vault. */
export const credentialRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const principal = async (c: Context) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const user = await ctx.requireUser(c)
    if (user instanceof Response) return user
    return { org, userId: user.id }
  }
  const owned = async (c: Context) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const connection = await ctx.meta.getConnection(c.req.param("id") ?? "")
    if (
      !connection ||
      connection.org_id !== auth.org ||
      !credentialVisible(connection, auth.userId)
    )
      return fail(c, 404, "not found")
    const canManage = await ctx.workspaceCan(c, "manage")
    if (connection.scope === "workspace" && !canManage)
      return fail(c, 403, "Workspace management access is required")
    return { ...auth, connection, canManage }
  }
  app.get("/v1/credentials", async (c) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const canManage = await ctx.workspaceCan(c, "manage")
    return c.json({
      can_create_workspace: canManage,
      items: (await ctx.meta.listConnections(auth.org))
        .filter((connection) => credentialVisible(connection, auth.userId))
        .map((connection) => credentialView(connection, auth.userId, canManage)),
    })
  })
  app.get("/v1/credentials/:id/usage", async (c) => {
    const auth = await owned(c)
    if (auth instanceof Response) return auth
    const items: { id: string; name: string; kind: "context" | "workflow" | "automation" }[] = []
    let hiddenCount = 0
    for (const context of await ctx.meta.contextsWithManifests(auth.org)) {
      const runtime = await ctx.meta.getContextRuntimeForContext(context.id, auth.org)
      const ids = [
        ...parseConnectionIds(context.connection_ids),
        ...Object.values(readEnvironmentBindings(context.environment_bindings)),
        runtime?.connection_id,
      ]
      if (!ids.includes(auth.connection.id)) continue
      if (await ctx.canUserAskContext(auth.userId, context))
        items.push({
          id: context.id,
          name: context.name,
          kind: runtime?.connection_id === null ? "workflow" : "context",
        })
      else hiddenCount++
    }
    // Same catalogue as /v1/automations: workspace-readable, no instruction text in this view.
    for (const automation of await ctx.meta.automationsWithExecutors(auth.org)) {
      if (
        automation.runtime_id ||
        !parseConnectionIds(automation.connection_ids).includes(auth.connection.id)
      )
        continue
      items.push({ id: automation.id, name: `Task ${automation.id}`, kind: "automation" })
    }
    return c.json({ items, hidden_count: hiddenCount })
  })
  app.put("/v1/credentials/:id", async (c) => {
    const auth = await owned(c)
    if (auth instanceof Response) return auth
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        secret: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => !value.includes("\0"), "Value cannot contain a null character"),
        revision: z.string().length(64),
      }),
    )
    if (body instanceof Response) return body
    if (!ctx.deps.encryptionKey) return fail(c, 503, "Credential storage is not configured")
    if (
      auth.connection.status !== "active" ||
      credentialRevision(auth.connection) !== body.revision
    )
      return fail(c, 409, "Credential changed or was revoked. Reload before replacing it.")
    const updated = await ctx.meta.updateConnectionCredential(
      auth.connection.id,
      auth.org,
      {
        secret_enc: encryptSecret(body.secret, ctx.deps.encryptionKey),
        scopes_label: body.name,
      },
      auth.connection.secret_enc,
      "active",
    )
    if (!updated)
      return fail(c, 409, "Credential changed or was revoked. Reload before replacing it.")
    ctx.deps.pokeRuntime?.()
    return c.json(credentialView(updated, auth.userId, auth.canManage))
  })
  return app
}
