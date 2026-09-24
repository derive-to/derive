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
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(run.meta ?? "{}") ?? {}
  } catch {
    /* Older malformed receipts remain readable. */
  }
  const receipt = meta.runtime
  if (receipt && typeof receipt === "object") {
    const details = receipt as Record<string, unknown>
    const report =
      typeof details.report_short_id === "string"
        ? await ctx.meta.getByShortId(details.report_short_id)
        : null
    const canRead =
      report && report.org_id === run.org_id && (await ctx.authorizeStanding(c, "read", report))
    meta = {
      runtime: {
        outcome: details.outcome,
        save_status: details.save_status,
        released_at: details.released_at,
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
