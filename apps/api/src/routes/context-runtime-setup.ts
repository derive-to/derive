import { newId } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { connectionBindError, spendableConnections } from "../lib/broker"
import { manageableContext, runtimeAvailable, runtimePilotAllowed } from "../lib/context-access"
import { decryptSecret } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { modelConnections, OrtamClient } from "../lib/ortam-client"
import { managedRuntimeClient } from "../lib/runtime-controller"
import { runtimeSetupRequest, SETUP_RUNNER_PATH, SETUP_TIMEOUT_MS } from "../lib/runtime-setup"

export const contextRuntimeSetupRoutes = (ctx: AppContext) => {
  const { meta, deps } = ctx
  const app = new Hono()
  app.post("/v1/contexts/:id/runtime/setup", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (!(await runtimeAvailable(ctx, c, context.org_id)))
      return fail(c, 403, "Cloud run pilot is unavailable")
    const owner = await ctx.managementPrincipal(c)
    const managed = !!deps.runtime?.managed?.workspaceIds.has(context.org_id)
    if (!owner || (!managed && !(await meta.isInstanceOperator(owner))))
      return fail(c, 403, "Cloud run pilot is unavailable")
    if (!deps.runtime || !deps.encryptionKey || deps.runtime.runnerPath !== SETUP_RUNNER_PATH)
      return fail(c, 503, "Pinned runtime provisioning is not configured")
    if (context.import_source) return fail(c, 400, "Imported Contexts cannot run agents")
    const settings = await meta.getOrgSettings(context.org_id)
    if (!settings.hostedAgentsEnabled || !settings.agentWrites)
      return fail(c, 403, "Enable hosted agents and agent writes for this workspace")
    const body = await readJson(
      c,
      z.object({ connection_id: z.string().min(1).max(64).optional() }),
    )
    if (body instanceof Response) return body
    const connectionId = body.connection_id ?? null
    if (!connectionId && !managed) return fail(c, 400, "Choose a controller connection")
    if (connectionId && !(await runtimePilotAllowed(ctx, c, context.org_id)))
      return fail(c, 403, "Manual setup is operator-only")
    const prior = await meta.getRuntimeSetup(context.id, context.org_id)
    if (prior) {
      if (prior.connection_id !== connectionId || prior.phase === "failed")
        return fail(c, 409, "This Context already has a setup attempt")
      return c.json({
        setup: connectionId
          ? prior
          : {
              phase: prior.phase,
              cancelled_at: prior.cancelled_at,
              deadline_at: prior.deadline_at,
            },
      })
    }
    let auth: { organization_id: string; user_id: string }
    try {
      if (connectionId) {
        const error = await connectionBindError(
          meta,
          context.org_id,
          { userId: owner, canManage: await ctx.workspaceCan(c, "manage") },
          [connectionId],
        )
        if (error) return fail(c, 400, error)
        const connection = (await spendableConnections(meta, context.org_id, [connectionId]))[0]
        if (connection?.kind !== "secret" || !connection.secret_enc)
          return fail(c, 400, "Choose an active Ortam secret connection")
        const key = decryptSecret(connection.secret_enc, deps.encryptionKey)
        if (key === connection.secret_enc)
          return fail(c, 503, "Controller credential cannot be decrypted")
        auth = await new OrtamClient(deps.runtime.apiUrl, key, deps.runtimeFetch).authenticate()
      } else {
        const client = managedRuntimeClient(
          deps.runtime,
          context.org_id,
          context.id,
          deps.runtimeFetch,
        )
        auth = await client.authenticate()
        const connections = modelConnections.parse(await client.request("/agents", auth))
        if (!connections.items.some((item) => item.status === "active"))
          return fail(c, 409, "Connect a model account first")
      }
    } catch {
      return fail(c, 502, "Could not verify the cloud connection")
    }
    const id = newId("rts")
    const at = new Date()
    const setup = await meta.createRuntimeSetup(
      {
        id,
        org_id: context.org_id,
        context_id: context.id,
        agent_id: context.agent_id,
        created_by: owner,
        connection_id: connectionId,
        api_url: deps.runtime.apiUrl,
        ortam_org_id: auth.organization_id,
        ortam_user_id: auth.user_id,
        request_json: JSON.stringify({
          ...runtimeSetupRequest(id),
          ...(connectionId ? {} : { agent_connections: true }),
        }),
        deadline_at: new Date(at.getTime() + SETUP_TIMEOUT_MS).toISOString(),
      },
      at.toISOString(),
    )
    if (!setup) return fail(c, 409, "This Context already has a runtime or setup attempt")
    return c.json(
      {
        setup: connectionId
          ? setup
          : {
              phase: setup.phase,
              cancelled_at: setup.cancelled_at,
              deadline_at: setup.deadline_at,
            },
      },
      202,
    )
  })
  app.post("/v1/contexts/:id/runtime/setup/cancel", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const prior = await meta.getRuntimeSetup(context.id, context.org_id)
    if (!(await runtimeAvailable(ctx, c, context.org_id, prior)))
      return fail(c, 403, "Cloud run pilot is unavailable")
    if (await meta.getContextRuntimeForContext(context.id, context.org_id))
      return fail(c, 409, "Setup has completed; disable the runtime instead")
    await meta.cancelRuntimeSetup(context.id, context.org_id, new Date().toISOString())
    const setup = await meta.getRuntimeSetup(context.id, context.org_id)
    if (setup && !setup.cancelled_at && ["binding", "ready"].includes(setup.phase))
      return fail(c, 409, "Setup is connecting; disable the runtime once connected")
    return c.json({
      setup: setup?.connection_id
        ? setup
        : setup && {
            phase: setup.phase,
            cancelled_at: setup.cancelled_at,
            deadline_at: setup.deadline_at,
          },
    })
  })
  return app
}
