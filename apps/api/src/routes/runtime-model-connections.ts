import { newId, type RuntimeModelConnectionRecord } from "@derive/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { modelConnections, modelHarness, modelSignIn } from "../lib/ortam-client"
import { managedModelClient } from "../lib/runtime-controller"

const name = z.string().trim().min(1).max(100)
const view = (connection: RuntimeModelConnectionRecord, apiUrl: string | undefined) => ({
  id: connection.id,
  name: connection.name,
  provider: connection.provider,
  revision: connection.revision,
  revoked_at: connection.revoked_at,
  created_at: connection.created_at,
  updated_at: connection.updated_at,
  unavailable_reason: connection.revoked_at
    ? "Disconnected. Add an account and select it on the affected workflows."
    : connection.api_url !== apiUrl
      ? "This account can no longer run workflows in this workspace. Connect a new account."
      : null,
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
    const unavailableReason = !ctx.deps.runtime?.managed?.workspaceIds.has(auth.org)
      ? "Workflows that retain files are not available in this workspace."
      : !(await ctx.workspaceCan(c, "publish"))
        ? "Publish access is required to connect a workflow account."
        : !ctx.deps.runtime.managed.apiKey
          ? "Workflow account sign-in is not configured. Contact your workspace administrator."
          : null
    return c.json({
      can_create: unavailableReason === null,
      unavailable_reason: unavailableReason,
      items: (
        await ctx.meta.listRuntimeModelConnections(
          auth.org,
          auth.owner,
          c.req.query("include_revoked") === "true",
        )
      ).map((connection) => view(connection, ctx.deps.runtime?.apiUrl)),
    })
  })
  app.post(path, async (c) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const config = await available(c, auth.org)
    if (config instanceof Response) return config
    const body = await readJson(
      c,
      z.object({
        name,
        provider: z.enum(["codex", "claude-code"]),
        request_id: z.string().uuid().optional(),
      }),
    )
    if (body instanceof Response) return body
    // A retried create must resolve to the same provider identity, including when
    // the response was lost. Scope the client key to owner/workspace and payload.
    const id = body.request_id
      ? `rmc_${sha256(JSON.stringify([auth.org, auth.owner, body.request_id, body.name, body.provider])).slice(0, 40)}`
      : newId("rmc")
    const existing = await ctx.meta.getRuntimeModelConnection(id, auth.org)
    if (existing) return c.json(view(existing, config.apiUrl))
    const reference = { id, org_id: auth.org, api_url: config.apiUrl }
    let account: { organization_id: string; user_id: string }
    try {
      account = await managedModelClient(config, reference, ctx.deps.runtimeFetch).authenticate()
    } catch {
      return fail(c, 502, "Could not verify the cloud connection")
    }
    const connection = await ctx.meta
      .createRuntimeModelConnection(
        {
          ...reference,
          name: body.name,
          provider: body.provider,
          created_by: auth.owner,
          ortam_org_id: account.organization_id,
          ortam_user_id: account.user_id,
        },
        new Date().toISOString(),
      )
      .catch(async (error: unknown) => {
        // A concurrent retry may have inserted this exact identity first.
        const winner = await ctx.meta.getRuntimeModelConnection(id, auth.org)
        if (winner) return winner
        throw error
      })
    return c.json(view(connection, ctx.deps.runtime?.apiUrl), 201)
  })
  app.get(`${path}/:connection`, async (c) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    return c.json(view(connection, ctx.deps.runtime?.apiUrl))
  })
  // Only the owner may inspect account usage. A grant can outlive their access
  // to the workflow; count that impact without revealing its name or identifier.
  app.get(`${path}/:connection/usage`, async (c) => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    const workflows: { id: string; name: string }[] = []
    let otherWorkflowCount = 0
    for (const context of await ctx.meta.contextsWithManifests(connection.org_id)) {
      const binding = await ctx.meta.getRuntimeModelBinding(context.id, connection.org_id)
      if (binding?.model_connection_id !== connection.id) continue
      if (await ctx.canUserAskContext(connection.created_by, context))
        workflows.push({ id: context.id, name: context.name })
      else otherWorkflowCount++
    }
    return c.json({ workflows, other_workflow_count: otherWorkflowCount })
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
      ? c.json(view(updated, ctx.deps.runtime?.apiUrl))
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
    ctx.deps.pokeRuntime?.()
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
      const current = await ctx.meta.getRuntimeModelConnection(connection.id, connection.org_id)
      if (!current || current.revoked_at) return c.json({ account: null, revoked: true })
      return c.json({
        account:
          models.items.find((item) => item.harness === modelHarness(connection.provider)) ?? null,
        revoked: false,
      })
    } catch {
      return fail(c, 502, "Could not check the model account")
    }
  })

  const signInRequest = async (c: Context, action: "start" | "read" | "complete" | "cancel") => {
    const connection = await owned(c)
    if (connection instanceof Response) return connection
    if (connection.revoked_at) return fail(c, 409, "This connection has been revoked")
    // Withdrawing admission must still allow the owner to inspect or cancel
    // an existing attempt, just as it allows disconnect cleanup.
    if (action === "start" || action === "complete") {
      const config = await available(c, connection.org_id)
      if (config instanceof Response) return config
    }
    try {
      const client = clientFor(connection)
      let result: z.infer<typeof modelSignIn>
      if (action === "start") {
        result = modelSignIn.parse(
          await client.request(
            `/agents/${modelHarness(connection.provider)}/sign-in`,
            identity(connection),
            "POST",
          ),
        )
      } else {
        const attemptId = c.req.param("attempt")
        if (!attemptId) return fail(c, 404, "not found")
        if (action === "complete") {
          const body = await readJson(c, z.object({ code: z.string().trim().min(1).max(4096) }))
          if (body instanceof Response) return body
          result = await client.completeModelSignIn(attemptId, body.code, identity(connection))
        } else {
          result = modelSignIn.parse(
            await client.request(
              `/agent-sign-in-attempts/${encodeURIComponent(attemptId)}${action === "cancel" ? "/cancel" : ""}`,
              identity(connection),
              action === "read" ? "GET" : "POST",
            ),
          )
        }
      }
      // A slow sign-in must not report success after the owner disconnected it.
      const current = await ctx.meta.getRuntimeModelConnection(connection.id, connection.org_id)
      if (!current || current.revoked_at) {
        await disconnect(connection)
        return fail(c, 409, "This connection has been revoked")
      }
      return c.json(result, action === "start" ? 202 : 200)
    } catch {
      return fail(c, 502, "Could not update model sign-in. Check the connection and try again.")
    }
  }
  app.post(`${path}/:connection/sign-in`, (c) => signInRequest(c, "start"))
  app.get(`${path}/:connection/sign-in/:attempt`, (c) => signInRequest(c, "read"))
  app.post(`${path}/:connection/sign-in/:attempt/complete`, (c) => signInRequest(c, "complete"))
  app.post(`${path}/:connection/sign-in/:attempt/cancel`, (c) => signInRequest(c, "cancel"))
  return app
}
