import { newId } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { manageableContext, runtimePilotAllowed } from "../lib/context-access"
import { fail, readJson } from "../lib/http"
import { nextRuntimeOccurrence } from "../lib/runtime-schedule"

export const contextRuntimeScheduleRoutes = (ctx: AppContext) => {
  const app = new Hono()
  app.put("/v1/contexts/:id/runtime/schedule", async (c) => {
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    if (!(await runtimePilotAllowed(ctx, c, context.org_id)))
      return fail(c, 403, "Cloud run pilot is unavailable")
    const body = await readJson(
      c,
      z.object({
        instruction: z.string().trim().min(1).max(16000),
        provider: z.enum(["codex", "claude-code"]),
        cron: z.string().trim().min(1).max(128),
        timezone: z.string().min(1).max(128),
        enabled: z.boolean(),
        revision: z.number().int().nonnegative().nullable(),
      }),
    )
    if (body instanceof Response) return body
    const settings = await ctx.meta.getOrgSettings(context.org_id)
    if (
      body.enabled &&
      (!ctx.deps.runtime ||
        !settings.hostedAgentsEnabled ||
        !settings.agentWrites ||
        !settings.automateBeta)
    )
      return fail(
        c,
        403,
        "Enable cloud execution, hosted agents, agent writes and automations for this workspace",
      )
    const runtime = await ctx.meta.getContextRuntimeForContext(context.id, context.org_id)
    const owner = await ctx.managementPrincipal(c)
    if (!runtime || runtime.disabled_at || !owner)
      return fail(c, 409, "Connect an active runtime first")
    let next: string
    try {
      next = nextRuntimeOccurrence(body.cron, body.timezone)
    } catch {
      return fail(c, 400, "Use a valid five-field cron expression and IANA timezone")
    }
    const schedule = await ctx.meta.saveRuntimeSchedule({
      ...body,
      id: newId("auto"),
      runtimeId: runtime.id,
      orgId: context.org_id,
      ownerId: owner,
      at: new Date().toISOString(),
    })
    if (!schedule) return fail(c, 409, "Schedule changed; reload before saving")
    return c.json({ schedule, next_run_at: body.enabled ? next : null })
  })
  return app
}
