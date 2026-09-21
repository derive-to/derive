import { refRouter } from "@derive/broker"
import { newId, type RuntimeRunInput } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import {
  brokerFor,
  callTool,
  connectionBindError,
  mcpAuthFor,
  spendableConnections,
  toolsForRun,
} from "../lib/broker"
import { manageableContext } from "../lib/context-access"
import { readEnvironmentBindings } from "../lib/context-environment"
import { decryptSecret } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { OrtamClient } from "../lib/ortam-client"
import { verifyRuntimeToken } from "../lib/runtime-token"

export const contextRuntimeRoutes = (ctx: AppContext) => {
  const { meta, deps } = ctx
  const app = new Hono()
  app.get("/v1/contexts/:id/runtime", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const runtime = await meta.getContextRuntimeForContext(context.id, context.org_id)
    const viewer = await ctx.managementPrincipal(c)
    const runs = runtime
      ? (await meta.listRuns(context.org_id, 100)).filter((r) => r.runtime_id === runtime.id)
      : []
    return c.json({
      enabled: !!deps.runtime,
      runtime,
      runs: await Promise.all(
        runs.map(async (run) => {
          const attempt = await meta.getLatestRunAttempt(run.id, run.org_id)
          return {
            ...run,
            attempt: attempt && {
              ...attempt,
              result_json: run.initiated_by === viewer ? attempt.result_json : null,
            },
          }
        }),
      ),
    })
  })
  app.post("/v1/contexts/:id/runtime", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (!deps.runtime || !deps.encryptionKey)
      return fail(c, 503, "Ortam execution is not configured")
    if (context.import_source) return fail(c, 400, "Imported Contexts cannot run agents")
    const body = await readJson(
      c,
      z.object({
        connection_id: z.string().min(1).max(64),
        sandbox_id: z.string().regex(/^sbx_[a-z0-9]{26}$/),
      }),
    )
    if (body instanceof Response) return body
    const error = await connectionBindError(
      meta,
      context.org_id,
      { userId: await ctx.managementPrincipal(c), canManage: await ctx.workspaceCan(c, "manage") },
      [body.connection_id],
    )
    if (error) return fail(c, 400, error)
    const connection = (await spendableConnections(meta, context.org_id, [body.connection_id]))[0]
    if (connection?.kind !== "secret" || !connection.secret_enc)
      return fail(c, 400, "Choose an active Ortam secret connection")
    const key = decryptSecret(connection.secret_enc, deps.encryptionKey)
    if (key === connection.secret_enc) return fail(c, 503, "Ortam credential cannot be decrypted")
    try {
      const client = new OrtamClient(deps.runtime.apiUrl, key, deps.runtimeFetch)
      const auth = await client.authenticate()
      const sandbox = await client.sandbox(body.sandbox_id, auth)
      if (
        sandbox.state !== "stopped" ||
        sandbox.agent_connections?.user_id !== auth.user_id ||
        sandbox.auto_stop_after_seconds <= 0 ||
        sandbox.auto_stop_after_seconds > 1200
      )
        return fail(
          c,
          400,
          "Use a stopped sandbox with this user's agent connection and an auto-stop limit of 1–1200 seconds",
        )
      const runtime = await meta.createContextRuntime(
        {
          id: newId("rt"),
          org_id: context.org_id,
          context_id: context.id,
          agent_id: context.agent_id,
          api_url: deps.runtime.apiUrl,
          ortam_org_id: auth.organization_id,
          ortam_user_id: auth.user_id,
          sandbox_id: sandbox.id,
          connection_id: connection.id,
        },
        new Date().toISOString(),
      )
      if (!runtime) return fail(c, 409, "This Context or sandbox already has a runtime binding")
      return c.json({ runtime }, 201)
    } catch {
      return fail(c, 502, "Could not verify the Ortam sandbox and credential")
    }
  })
  app.post("/v1/contexts/:id/runtime/runs", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (!deps.runtime) return fail(c, 503, "Ortam execution is not configured")
    const body = await readJson(
      c,
      z.object({
        instruction: z.string().trim().min(1).max(16000),
        provider: z.enum(["codex", "claude-code"]),
        model: z.string().min(1).max(128).nullable().default(null),
      }),
    )
    if (body instanceof Response) return body
    const settings = await meta.getOrgSettings(context.org_id)
    if (!settings.hostedAgentsEnabled || !settings.agentWrites)
      return fail(c, 403, "Enable hosted agents and agent writes for this workspace")
    const runtime = await meta.getContextRuntimeForContext(context.id, context.org_id)
    const manifest = (await meta.currentVersions([context.manifest_artifact_id]))[
      context.manifest_artifact_id
    ]
    if (!runtime || runtime.disabled_at || !manifest)
      return fail(c, 409, "Context runtime or manifest is unavailable")
    const input: RuntimeRunInput = {
      version: 1,
      ...body,
      context_id: context.id,
      manifest: {
        artifact_id: context.manifest_artifact_id,
        version: manifest.n,
        blob_key: manifest.blob_key,
      },
      connection_ids: JSON.parse(context.connection_ids ?? "[]"),
      environment_bindings: readEnvironmentBindings(context.environment_bindings),
    }
    const run = await meta.createRun({
      id: newId("run"),
      org_id: context.org_id,
      agent_id: context.agent_id,
      initiated_by: await ctx.managementPrincipal(c),
      reason: "manual:runtime",
      runtime_id: runtime.id,
      input_snapshot: JSON.stringify(input),
    })
    return c.json({ run }, 201)
  })
  app.post("/v1/contexts/:id/runtime/disable", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const runtime = await meta.getContextRuntimeForContext(context.id, context.org_id)
    if (runtime)
      await meta.disableContextRuntime(runtime.id, context.org_id, new Date().toISOString())
    return c.json({ disabled: true })
  })

  const authenticate = async (c: Parameters<typeof manageableContext>[1]) => {
    const bearer = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? ""
    const claim = deps.encryptionKey
      ? await verifyRuntimeToken(deps.encryptionKey, bearer, Date.now())
      : null
    if (!claim || claim.id !== c.req.param("id")) return null
    const attempt = await meta.getRunAttempt(claim.id, claim.orgId)
    const run = attempt ? await meta.getRun(attempt.run_id) : null
    return attempt && run?.org_id === claim.orgId ? { attempt, run } : null
  }
  // authz-exempt: authenticate verifies the signed attempt capability; it deliberately grants no general agent identity.
  app.post("/v1/runtime-attempts/:id/claim", async (c) => {
    c.header("Cache-Control", "no-store")
    const work = await authenticate(c)
    if (!work) return fail(c, 401, "Invalid attempt token")
    const { attempt, run } = work
    if (!run.runtime_id || !run.input_snapshot || !deps.encryptionKey)
      return fail(c, 409, "Run input is unavailable")
    const runtime = await meta.getContextRuntime(run.runtime_id, run.org_id)
    const input = JSON.parse(run.input_snapshot) as RuntimeRunInput
    const context = await meta.getContext(input.context_id)
    const settings = await meta.getOrgSettings(run.org_id)
    const agent = await meta.getAgent(run.agent_id)
    if (
      !runtime ||
      runtime.disabled_at ||
      context?.org_id !== run.org_id ||
      context.agent_id !== run.agent_id ||
      agent?.org_id !== run.org_id ||
      !settings.hostedAgentsEnabled ||
      !settings.agentWrites ||
      !run.initiated_by ||
      !(await meta.getMembership(run.org_id, run.initiated_by))
    )
      return fail(c, 403, "Runtime access has been revoked")
    const current = readEnvironmentBindings(context.environment_bindings)
    const environment: Record<string, string> = {}
    const connections = await spendableConnections(
      meta,
      run.org_id,
      Object.values(input.environment_bindings),
    )
    for (const [name, id] of Object.entries(input.environment_bindings)) {
      const connection = connections.find((cn) => cn.id === id)
      if (current[name] !== id || connection?.kind !== "secret" || !connection.secret_enc)
        return fail(c, 409, "The selected environment changed; queue a new run")
      const value = decryptSecret(connection.secret_enc, deps.encryptionKey)
      if (value === connection.secret_enc || value.includes("\0"))
        return fail(c, 503, "A selected secret is unreadable")
      environment[name] = value
    }
    const version = await meta.getVersion(input.manifest.artifact_id, input.manifest.version)
    const bytes =
      version?.blob_key === input.manifest.blob_key
        ? await deps.blobs.get(input.manifest.blob_key)
        : null
    if (!bytes || bytes.byteLength > 256_000)
      return fail(c, 409, "Pinned manifest is unavailable or too large")

    const selected = input.connection_ids.filter((id) =>
      (JSON.parse(context.connection_ids ?? "[]") as string[]).includes(id),
    )
    const broker = await brokerFor(meta, run.org_id, null, deps.encryptionKey, deps.allowEchoStub)
    const router = refRouter(broker, mcpAuthFor(meta, run.org_id, deps.encryptionKey))
    const tools = await toolsForRun(meta, broker, run.org_id, selected, router, deps.encryptionKey)
    const claimed = await meta.claimRunAttempt(attempt.id, run.org_id, new Date().toISOString())
    if (!claimed) return c.json({ claimed: false })
    return c.json({
      claimed: true,
      input,
      tools,
      manifest: new TextDecoder().decode(bytes),
      environment,
      deadline_at: attempt.deadline_at,
    })
  })
  // authz-exempt: attempt capability plus live Context grant intersection bounds each broker call.
  app.post("/v1/runtime-attempts/:id/tool", async (c) => {
    const work = await authenticate(c)
    if (!work) return fail(c, 401, "Invalid attempt token")
    const { attempt, run } = work
    if (
      !attempt.runner_claimed_at ||
      attempt.result_json ||
      attempt.released_at ||
      !["launching", "running"].includes(attempt.phase) ||
      attempt.deadline_at <= new Date().toISOString()
    )
      return fail(c, 409, "Attempt is not running")
    const runtime = await meta.getContextRuntime(attempt.runtime_id, run.org_id)
    const context = runtime ? await meta.getContext(runtime.context_id) : null
    const settings = await meta.getOrgSettings(run.org_id)
    if (
      !runtime ||
      runtime.disabled_at ||
      context?.org_id !== run.org_id ||
      context.agent_id !== run.agent_id ||
      !settings.agentWrites ||
      !settings.hostedAgentsEnabled ||
      !run.initiated_by ||
      !(await meta.getMembership(run.org_id, run.initiated_by))
    )
      return fail(c, 403, "Runtime access has been revoked")
    const body = await readJson(
      c,
      z.object({ tool: z.string().max(200), args: z.unknown().optional() }),
    )
    if (body instanceof Response) return body
    const input = JSON.parse(run.input_snapshot ?? "null") as RuntimeRunInput
    const current = JSON.parse(context.connection_ids ?? "[]") as string[]
    const selected = input.connection_ids.filter((id) => current.includes(id))
    const broker = await brokerFor(meta, run.org_id, null, deps.encryptionKey, deps.allowEchoStub)
    const route = refRouter(broker, mcpAuthFor(meta, run.org_id, deps.encryptionKey))
    const allowed = await toolsForRun(meta, broker, run.org_id, selected, route, deps.encryptionKey)
    const out = await callTool({
      meta,
      broker,
      route,
      orgId: run.org_id,
      encryptionKey: deps.encryptionKey,
      allowed,
      subject: "this attempt",
      tool: body.tool,
      args: body.args,
    })
    return out.ok ? c.json({ result: out.result }) : fail(c, out.status, out.message)
  })
  // authz-exempt: authenticate verifies the attempt capability; immutable receipt replay grants no additional writes.
  app.post("/v1/runtime-attempts/:id/result", async (c) => {
    const work = await authenticate(c)
    if (!work) return fail(c, 401, "Invalid attempt token")
    const body = await readJson(
      c,
      z.object({
        version: z.literal(1),
        outcome: z.enum([
          "completed",
          "completed_with_gaps",
          "no_change",
          "needs_input",
          "failed",
          "cancelled",
        ]),
        summary: z.string().min(1).max(16000),
        outputs: z.array(z.never()).length(0),
      }),
    )
    if (body instanceof Response) return body
    if (!work.attempt.runner_claimed_at) return fail(c, 409, "Attempt has not been claimed")
    const receipt = await meta.acceptRunAttemptResult(
      work.attempt.id,
      work.run.org_id,
      body,
      new Date().toISOString(),
    )
    if (!receipt)
      return fail(c, 409, "Attempt is closed or a different result was already accepted")
    return c.json({ accepted: true })
  })
  return app
}
