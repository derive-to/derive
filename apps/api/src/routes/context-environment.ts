import type { ContextRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { connectionBindError, spendableConnections } from "../lib/broker"
import { manageableContext } from "../lib/context-access"
import { EnvironmentBindings, readEnvironmentBindings } from "../lib/context-environment"
import { decryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

const EnvironmentInfo = z.object({ bindings: EnvironmentBindings }).openapi("ContextEnvironment")

export const contextEnvironmentRoutes = (ctx: AppContext) => {
  const { meta, managementPrincipal, workspaceCan, agentFor, agentRunScope, agentSessionScope } =
    ctx
  const app = new OpenAPIHono<BlankEnv>()
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}/environment",
      tags: ["Contexts"],
      summary: "Read environment variable bindings (manager only; never returns secret values).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Names and secret connection IDs.",
          content: { "application/json": { schema: EnvironmentInfo } },
        },
      },
    }),
    async (c) => {
      const context = await manageableContext(ctx, c)
      if (context instanceof Response) return bail(context)
      if (context.import_source) return bail(fail(c, 400, "Imported Contexts cannot run agents"))
      return c.json({ bindings: readEnvironmentBindings(context.environment_bindings) })
    },
  )
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/contexts/{id}/environment",
      tags: ["Contexts"],
      summary:
        "Replace the secret connections delivered as environment variables to this Context's runner.",
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: EnvironmentInfo } } },
      },
      responses: {
        200: {
          description: "Saved bindings; values remain write-only.",
          content: { "application/json": { schema: EnvironmentInfo } },
        },
      },
    }),
    async (c) => {
      const context = await manageableContext(ctx, c)
      if (context instanceof Response) return bail(context)
      if (context.import_source) return bail(fail(c, 400, "Imported Contexts cannot run agents"))
      const body = await readJson(c, EnvironmentInfo)
      if (body instanceof Response) return bail(body)
      const ids = [...new Set(Object.values(body.bindings))]
      const error = await connectionBindError(
        meta,
        context.org_id,
        {
          userId: await managementPrincipal(c),
          canManage: await workspaceCan(c, "manage"),
        },
        ids,
      )
      if (error) return bail(fail(c, 400, error))
      const connections = await spendableConnections(meta, context.org_id, ids)
      if (
        connections.length !== ids.length ||
        connections.some((cn) => cn.kind !== "secret" || !cn.secret_enc)
      )
        return bail(fail(c, 400, "Environment variables require active secret connections"))
      await meta.setContextEnvironment(
        context.id,
        ids.length ? JSON.stringify(body.bindings) : null,
      )
      return c.json({ bindings: body.bindings })
    },
  )

  // The only plaintext read: an authenticated runner asking about its own active work.
  // Browser users and unrelated work items cannot use this as a secret-reveal endpoint.
  app.get("/v1/agent/environment", async (c) => {
    c.header("Cache-Control", "no-store")
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "unauthenticated")
    const sessionId = c.req.query("session")
    const runId = c.req.query("run")
    if (!!sessionId === !!runId) return fail(c, 400, "Pass exactly one session or run")
    const runScope = agentRunScope(c)
    const sessionScope = agentSessionScope(c)
    if (
      (runScope && (sessionId || runId !== runScope)) ||
      (sessionScope && (runId || sessionId !== sessionScope))
    )
      return fail(c, 403, "A work token may only read its own environment")
    let context: ContextRecord | null = null
    if (sessionId) {
      const session = await meta.getSession(sessionId)
      context = session?.context_id ? await meta.getContext(session.context_id) : null
      if (
        !session ||
        session.org_id !== agent.org_id ||
        !context ||
        context.org_id !== agent.org_id ||
        context.agent_id !== agent.id
      )
        return fail(c, 404, "unknown session")
      if (session.state !== "working") return fail(c, 409, "Session is not running")
    } else if (runId) {
      const run = await meta.getRun(runId)
      if (!run || run.org_id !== agent.org_id || run.agent_id !== agent.id)
        return fail(c, 404, "unknown run")
      if (run.status !== "running") return fail(c, 409, "Run is not running")
      const automation = run.automation_id ? await meta.getAutomation(run.automation_id) : null
      if (
        run.automation_id &&
        (!automation || automation.org_id !== agent.org_id || automation.agent_id !== agent.id)
      )
        return fail(c, 409, "The run's automation is no longer available to this agent")
      context = automation?.context_id ? await meta.getContext(automation.context_id) : null
      if (
        automation?.context_id &&
        (!context || context.agent_id !== agent.id || context.org_id !== agent.org_id)
      )
        return fail(c, 403, "Context is no longer available to this run")
    }
    if (!context) return c.json({ environment: {} })
    const bindings = readEnvironmentBindings(context.environment_bindings)
    const ids = [...new Set(Object.values(bindings))]
    if (!ids.length) return c.json({ environment: {} })
    if (!ctx.deps.encryptionKey) return fail(c, 503, "Secret encryption is not configured")
    const connections = await spendableConnections(meta, agent.org_id, ids)
    const byId = new Map(connections.map((cn) => [cn.id, cn]))
    const environment: Record<string, string> = {}
    for (const [name, id] of Object.entries(bindings)) {
      const connection = byId.get(id)
      if (connection?.kind !== "secret" || !connection.secret_enc)
        return fail(c, 409, `Environment variable ${name} is unavailable; update Context access`)
      const value = decryptSecret(connection.secret_enc, ctx.deps.encryptionKey)
      if (value === connection.secret_enc)
        return fail(c, 503, `Environment variable ${name} could not be decrypted`)
      if (value.includes("\0"))
        return fail(c, 400, `Environment variable ${name} contains a null character`)
      environment[name] = value
    }
    return c.json({ environment })
  })
  return app
}
