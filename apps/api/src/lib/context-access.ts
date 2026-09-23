import type { ContextRecord } from "@derive/core"
import type { Context } from "hono"
import type { AppContext } from "../context"
import { fail } from "./http"

/** Context management belongs to its creator or an active workspace manager, never a runner. */
export async function manageableContext(
  ctx: AppContext,
  c: Context,
): Promise<ContextRecord | Response> {
  const userId = await ctx.managementPrincipal(c)
  if (!userId) return fail(c, 401, "unauthenticated")
  const context = await ctx.meta.getContext(c.req.param("id") ?? "")
  if (!context || context.org_id !== (await ctx.activeWorkspace(c)))
    return fail(c, 404, "not found")
  if (context.created_by !== userId && !(await ctx.workspaceCan(c, "manage")))
    return fail(c, 403, "forbidden")
  return context
}

/** Manual machine setup and diagnostics are temporary operator tooling, not Context-owner powers.
 * Management OAuth may act for an existing operator, but still needs its workspace/manage grant. */
export async function runtimePilotAllowed(
  ctx: AppContext,
  c: Context,
  orgId: string,
): Promise<boolean> {
  if (!ctx.deps.runtime?.pilotWorkspaceIds.has(orgId)) return false
  const userId = await ctx.managementPrincipal(c)
  return !!userId && ((await ctx.isSuperAdmin(c)) || (await ctx.meta.isInstanceOperator(userId)))
}

/** Managed jobs follow the automation run permission. Editing still belongs to
 * the Context creator or a workspace manager; a caller never supplies an agent ID. */
export async function runnableContext(ctx: AppContext, c: Context) {
  const orgId = await ctx.requireWorkspace(c, "publish")
  if (orgId instanceof Response) return orgId
  if (!(await ctx.managementPrincipal(c))) return fail(c, 401, "unauthenticated")
  const context = await ctx.meta.getContext(c.req.param("id") ?? "")
  if (!context || context.org_id !== orgId) return fail(c, 404, "not found")
  if (ctx.deps.runtime?.managed?.workspaceIds.has(orgId)) {
    const userId = await ctx.managementPrincipal(c)
    if (!userId || !(await ctx.canUserAskContext(userId, context))) return fail(c, 403, "forbidden")
    return context
  }
  return manageableContext(ctx, c)
}

export async function runtimeAvailable(ctx: AppContext, c: Context, orgId: string) {
  return !!ctx.deps.runtime?.managed?.workspaceIds.has(orgId) || runtimePilotAllowed(ctx, c, orgId)
}
