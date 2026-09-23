import { newId, type RuntimeModelConnectionRecord } from "@derive/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"
import { modelConnections, modelHarness, modelSignIn } from "../lib/ortam-client"
import { managedModelClient } from "../lib/runtime-controller"

const name = z.string().trim().min(1).max(100)
const view = (connection: RuntimeModelConnectionRecord) => ({
  id: connection.id,
  name: connection.name,
  provider: connection.provider,
  revision: connection.revision,
  revoked_at: connection.revoked_at,
  created_at: connection.created_at,
  updated_at: connection.updated_at,
})

/** Reusable account management. Owning a job or knowing a connection ID does not
 * grant permission to replace its owner's login. Job grants are a separate concern. */
export const runtimeModelConnectionRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const path = "/v1/runtime-model-connections"
  const principal = async (c: Context) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const owner = await ctx.managementPrincipal(c)
    if (!owner) return fail(c, 403, "A model account owner is required")
    return { org, owner }
  }
  const owned = async (c: Context) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const connection = await ctx.meta.getRuntimeModelConnection(
      c.req.param("connection") ?? "",
      auth.org,
    )
    if (!connection || connection.created_by !== auth.owner) return fail(c, 404, "not found")
    return connection
  }
  const available = async (c: Context, org: string) => {
    if (!ctx.deps.runtime?.managed?.workspaceIds.has(org)) return fail(c, 404, "not found")
    if (!(await ctx.workspaceCan(c, "publish"))) return fail(c, 403, "Publish access required")
    if (!ctx.deps.runtime.managed.apiKey) return fail(c, 503, "Cloud execution is not configured")
    return ctx.deps.runtime
  }
  const clientFor = (connection: RuntimeModelConnectionRecord) => {
    if (!ctx.deps.runtime) throw new Error("Cloud execution is not configured")
    return managedModelClient(ctx.deps.runtime, connection, ctx.deps.runtimeFetch)
  }
  const identity = (connection: RuntimeModelConnectionRecord) => ({
    organization_id: connection.ortam_org_id,
    user_id: connection.ortam_user_id,
  })
  const disconnect = async (connection: RuntimeModelConnectionRecord) => {
    await clientFor(connection).request(
      `/agents/${modelHarness(connection.provider)}`,
      identity(connection),
      "DELETE",
    )
  }

  app.get(path, async (c) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    return c.json({
      items: (await ctx.meta.listRuntimeModelConnections(auth.org, auth.owner)).map(view),
    })
  })
  app.post(path, async (c) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const config = await available(c, auth.org)
    if (config instanceof Response) return config
    const body = await readJson(c, z.object({ name, provider: z.enum(["codex", "claude-code"]) }))
    if (body instanceof Response) return body
    const reference = { id: newId("rmc"), org_id: auth.org, api_url: config.apiUrl }
    let account: { organization_id: string; user_id: string }
    try {
      account = await managedModelClient(config, reference, ctx.deps.runtimeFetch).authenticate()
    } catch {
      return fail(c, 502, "Could not verify the cloud connection")
    }
    const connection = await ctx.meta.createRuntimeModelConnection(
      {
        ...reference,
        ...body,
        created_by: auth.owner,
        ortam_org_id: account.organization_id,
        ortam_user_id: account.user_id,
      },
      new Date().toISOString(),
    )
    return c.json(view(connection), 201)
  })
  app.get(`${path}/:connection`, async (c) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    return c.json(view(connection))
  })
  app.patch(`${path}/:connection`, async (c) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    const body = await readJson(c, z.object({ name, revision: z.number().int().nonnegative() }))
    if (body instanceof Response) return body
    const updated = await ctx.meta.renameRuntimeModelConnection(
      connection.id,
      connection.org_id,
      body.revision,
      body.name,
      new Date().toISOString(),
    )
    return updated
      ? c.json(view(updated))
      : fail(c, 409, "Model connection changed; reload and try again")
  })
  app.delete(`${path}/:connection`, async (c) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    // The local grant is withdrawn even when the provider is unavailable. Retain
    // this record so DELETE can retry remote cleanup with the original identity.
    await ctx.meta.revokeRuntimeModelConnection(
      connection.id,
      connection.org_id,
      new Date().toISOString(),
    )
    try {
      await disconnect(connection)
    } catch {
      return fail(c, 502, "Connection revoked; cloud disconnect is incomplete. Retry disconnect.")
    }
    return c.json({ disconnected: true })
  })
  app.get(`${path}/:connection/status`, async (c) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    if (connection.revoked_at) return c.json({ account: null, revoked: true })
    try {
      const models = modelConnections.parse(
        await clientFor(connection).request("/agents", identity(connection)),
      )
      return c.json({
        account:
          models.items.find((item) => item.harness === modelHarness(connection.provider)) ?? null,
        revoked: false,
      })
    } catch {
      return fail(c, 502, "Could not check the model account")
    }
  })

  const signInRequest = async (c: Context, suffix: string, method = "GET", body?: unknown) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    const config = await available(c, connection.org_id)
    if (config instanceof Response) return config
    if (connection.revoked_at) return fail(c, 409, "This connection has been revoked")
    try {
      const result = modelSignIn.parse(
        await clientFor(connection).request(
          suffix === "/sign-in" ? `/agents/${modelHarness(connection.provider)}/sign-in` : suffix,
          identity(connection),
          method,
          body,
        ),
      )
      // A slow sign-in must not report success after the owner disconnected it.
      const current = await ctx.meta.getRuntimeModelConnection(connection.id, connection.org_id)
      if (!current || current.revoked_at) {
        await disconnect(connection)
        return fail(c, 409, "This connection has been revoked")
      }
      return c.json(result, suffix === "/sign-in" ? 202 : 200)
    } catch {
      return fail(c, 502, "Could not update model sign-in. Check the connection and try again.")
    }
  }
  const attemptPath = (c: Context) =>
    `/agent-sign-in-attempts/${encodeURIComponent(c.req.param("attempt") ?? "")}`
  app.post(`${path}/:connection/sign-in`, (c) => signInRequest(c, "/sign-in", "POST"))
  app.get(`${path}/:connection/sign-in/:attempt`, (c) => signInRequest(c, attemptPath(c)))
  app.post(`${path}/:connection/sign-in/:attempt/complete`, async (c) => {
    const body = await readJson(c, z.object({ code: z.string().trim().min(1).max(8192) }))
    if (body instanceof Response) return body
    return signInRequest(c, `${attemptPath(c)}/complete`, "POST", body)
  })
  app.post(`${path}/:connection/sign-in/:attempt/cancel`, (c) =>
    signInRequest(c, `${attemptPath(c)}/cancel`, "POST"),
  )
  return app
}
