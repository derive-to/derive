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
