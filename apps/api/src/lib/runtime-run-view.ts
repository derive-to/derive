import type { RunRecord } from "@derive/core"
import type { Context } from "hono"
import type { AppContext } from "../context"

/** Runtime receipts link private artifacts. Workspace administration is not report readership. */
export async function runtimeRunView(ctx: AppContext, c: Context, run: RunRecord) {
  if (!run.runtime_id) return run
  const runtime = await ctx.meta.getContextRuntime(run.runtime_id, run.org_id)
  const context = runtime ? await ctx.meta.getContext(runtime.context_id) : null
  const user = await ctx.managementPrincipal(c)
  const allowed = context && user && (await ctx.canUserAskContext(user, context))
  let details: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(run.meta ?? "null")?.runtime
    if (value && typeof value === "object" && !Array.isArray(value)) details = value
  } catch {
    // Invalid stored metadata has no public fields.
  }
  let meta = {}
  if (details) {
    const report =
      typeof details.report_short_id === "string"
        ? await ctx.meta.getByShortId(details.report_short_id)
        : null
    const canRead =
      report && report.org_id === run.org_id && (await ctx.authorizeStanding(c, "read", report))
    meta = {
      runtime: {
        outcome: typeof details.outcome === "string" ? details.outcome : undefined,
        save_status: typeof details.save_status === "string" ? details.save_status : undefined,
        released_at: typeof details.released_at === "string" ? details.released_at : undefined,
        report_short_id: canRead ? details.report_short_id : null,
      },
    }
  }
  return {
    ...run,
    input_snapshot: null,
    meta: JSON.stringify(meta),
    workflow_name: allowed ? context.name : "Cloud workflow",
    context_id: allowed ? context.id : null,
  }
}
