import { newId } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { connectionBindError, spendableConnections } from "../lib/broker"
import { manageableContext, runtimePilotAllowed } from "../lib/context-access"
import { decryptSecret } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { OrtamClient } from "../lib/ortam-client"
import { runtimeSetupRequest, SETUP_RUNNER_PATH, SETUP_TIMEOUT_MS } from "../lib/runtime-setup"

export const contextRuntimeSetupRoutes = (ctx: AppContext) => {
  const { meta, deps } = ctx
  const app = new Hono()
  app.post("/v1/contexts/:id/runtime/setup", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (!(await runtimePilotAllowed(ctx, c, context.org_id)))
      return fail(c, 403, "Cloud run pilot is unavailable")
    const owner = await ctx.managementPrincipal(c)
    if (!owner || !(await meta.isInstanceOperator(owner)))
      return fail(c, 403, "Cloud run pilot is unavailable")
    if (!deps.runtime || !deps.encryptionKey || deps.runtime.runnerPath !== SETUP_RUNNER_PATH)
      return fail(c, 503, "Pinned runtime provisioning is not configured")
    if (context.import_source) return fail(c, 400, "Imported Contexts cannot run agents")
    const settings = await meta.getOrgSettings(context.org_id)
    if (!settings.hostedAgentsEnabled || !settings.agentWrites)
      return fail(c, 403, "Enable hosted agents and agent writes for this workspace")
    const body = await readJson(c, z.object({ connection_id: z.string().min(1).max(64) }))
    if (body instanceof Response) return body
    const error = await connectionBindError(
      meta,
      context.org_id,
      { userId: owner, canManage: await ctx.workspaceCan(c, "manage") },
      [body.connection_id],
    )
    if (error) return fail(c, 400, error)
    const prior = await meta.getRuntimeSetup(context.id, context.org_id)
    if (prior) {
      if (prior.connection_id !== body.connection_id || prior.phase === "failed")
        return fail(c, 409, "This Context already has a setup attempt")
      return c.json({ setup: prior }, 200)
    }
    const connection = (await spendableConnections(meta, context.org_id, [body.connection_id]))[0]
    if (connection?.kind !== "secret" || !connection.secret_enc)
      return fail(c, 400, "Choose an active Ortam secret connection")
    const key = decryptSecret(connection.secret_enc, deps.encryptionKey)
    if (key === connection.secret_enc) return fail(c, 503, "Ortam credential cannot be decrypted")
    let auth: { organization_id: string; user_id: string }
    try {
      auth = await new OrtamClient(deps.runtime.apiUrl, key, deps.runtimeFetch).authenticate()
    } catch {
      return fail(c, 502, "Could not verify the Ortam credential")
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
        connection_id: connection.id,
        api_url: deps.runtime.apiUrl,
        ortam_org_id: auth.organization_id,
        ortam_user_id: auth.user_id,
        request_json: JSON.stringify(runtimeSetupRequest(id)),
        deadline_at: new Date(at.getTime() + SETUP_TIMEOUT_MS).toISOString(),
      },
      at.toISOString(),
    )
    if (!setup) return fail(c, 409, "This Context already has a runtime or setup attempt")
    return c.json({ setup }, 202)
  })
  app.post("/v1/contexts/:id/runtime/setup/cancel", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (!(await runtimePilotAllowed(ctx, c, context.org_id)))
      return fail(c, 403, "Cloud run pilot is unavailable")
    if (await meta.getContextRuntimeForContext(context.id, context.org_id))
      return fail(c, 409, "Setup has completed; disable the runtime instead")
    if ((await meta.getRuntimeSetup(context.id, context.org_id))?.phase === "binding")
      return fail(c, 409, "Setup is connecting; disable the runtime once connected")
    await meta.cancelRuntimeSetup(context.id, context.org_id, new Date().toISOString())
    const setup = await meta.getRuntimeSetup(context.id, context.org_id)
    if (setup && !setup.cancelled_at && ["binding", "ready"].includes(setup.phase))
      return fail(c, 409, "Setup is connecting; disable the runtime once connected")
    return c.json({ setup })
  })
  return app
}
