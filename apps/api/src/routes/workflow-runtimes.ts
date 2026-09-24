import { newId, publish } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { afterPublish } from "../lib/after-publish"
import { runtimeAvailable } from "../lib/context-access"
import { ContextConflictError, createContextCore } from "../lib/create-context"
import { fail, readJson } from "../lib/http"
import { deleteArtifactAndUnindex } from "../lib/search"

/** A workflow view over existing execution records; Context and artifact contracts stay intact. */
export const workflowRuntimeRoutes = (ctx: AppContext) => {
  const app = new Hono()
  app.get("/v1/workflow-runtimes", async (c) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    const available = !!ctx.deps.runtime?.managed?.workspaceIds.has(org)
    const canRun = await ctx.workspaceCan(c, "publish")
    const rows = await ctx.meta.contextsWithManifests(org)
    const items = []
    for (const context of rows) {
      if (context.import_source || !(await ctx.canUserAskContext(user, context))) continue
      const [binding, runtime, setup] = await Promise.all([
        ctx.meta.getRuntimeModelBinding(context.id, org),
        ctx.meta.getContextRuntimeForContext(context.id, org),
        ctx.meta.getRuntimeSetup(context.id, org),
      ])
      if (!binding && !runtime && !setup) continue
      const accessible = canRun && (await runtimeAvailable(ctx, c, org, runtime ?? setup))
      // Operator machines are never exposed through the managed cloud workflow view.
      if ((runtime && runtime.connection_id !== null) || (setup && setup.connection_id !== null))
        continue
      const schedule = runtime ? await ctx.meta.getRuntimeSchedule(runtime.id, org) : null
      items.push({
        id: context.id,
        name: context.name,
        created_at: context.created_at,
        disabled: !!runtime?.disabled_at,
        preparing: !!setup && !["ready", "failed"].includes(setup.phase),
        ready: !!runtime && !runtime.disabled_at && !!schedule,
        can_open: accessible,
        schedule: schedule
          ? {
              enabled: !!schedule.enabled,
              trigger: JSON.parse(schedule.trigger) as { kind: string; cron?: string; tz?: string },
            }
          : null,
      })
    }
    return c.json({ available, can_create: available && canRun, items })
  })
  app.post("/v1/workflow-runtimes", async (c) => {
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    if (!ctx.deps.runtime?.managed?.workspaceIds.has(org))
      return fail(c, 403, "Cloud execution is not available in this workspace")
    const limited = await ctx.limited(c, ctx.publishLimiter)
    if (limited) return limited
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        model_connection_id: z.string().min(1).max(64),
      }),
    )
    if (body instanceof Response) return body
    const connection = await ctx.meta.getRuntimeModelConnection(body.model_connection_id, org)
    if (
      !connection ||
      connection.created_by !== user ||
      connection.revoked_at ||
      connection.api_url !== ctx.deps.runtime.apiUrl
    )
      return fail(c, 400, "Choose one of your available model accounts")
    const bytes = new TextEncoder().encode(
      "Follow the instructions supplied for each workflow run. Use only the selected tools and access. Produce a clear report of the outcome.\n",
    )
    if (await ctx.overStorage(org, bytes.length))
      return fail(c, 402, "Workspace storage limit reached")
    const published = await publish(ctx.meta, ctx.blobs, {
      bytes,
      filename: "manifest.md",
      isBundle: false,
      orgId: org,
      title: `${body.name} — instructions`,
      authorId: user,
      source: "web",
      workspaceAccess: "none",
      linkRole: "none",
      listed: "none",
    })
    try {
      await ctx.meta.setArtifactMember({
        id: newId("am"),
        artifact_id: published.artifact.id,
        user_id: user,
        role: "owner",
      })
      const { context } = await createContextCore(ctx.meta, {
        orgId: org,
        userId: user,
        name: body.name,
        manifestArtifactId: published.artifact.id,
      })
      const binding = await ctx.meta.saveRuntimeModelBinding({
        contextId: context.id,
        orgId: org,
        ownerId: user,
        connectionId: connection.id,
        revision: null,
        at: new Date().toISOString(),
      })
      if (!binding) {
        await ctx.meta.deleteContext(context.id, org)
        await ctx.meta.deleteAgent(context.agent_id, org)
        await deleteArtifactAndUnindex(ctx.meta, ctx.search, published.artifact.id, org)
        return fail(c, 409, "Model account access changed; choose an available account")
      }
      await afterPublish(ctx, published.artifact, published.version, {
        isNew: true,
        onBehalf: user,
        actorId: user,
      })
      return c.json({ id: context.id }, 201)
    } catch (error) {
      if (!(error instanceof ContextConflictError)) throw error
      await deleteArtifactAndUnindex(ctx.meta, ctx.search, published.artifact.id, org)
      return fail(c, 409, "A workflow or Context with that name already exists")
    }
  })
  return app
}
