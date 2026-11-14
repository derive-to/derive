import { Hono } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { createDashboards, DASHBOARDS_PATH, dashboardsViewer } from "../dashboards"
import { fail } from "../lib/http"
import { visibleArtifactsInWorkspace } from "../lib/visibility"

/**
 * The workspace's dashboards (derive-dashboards): every endpoint under /v1/dashboards, as the
 * signed-in member of the active workspace. Derive answers who is asking; the library answers
 * everything else, through the artifacts this person can open.
 */
export const dashboardsRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireWorkspace, workspaceRole } = ctx
  const app = new Hono<BlankEnv>()
  const dashboards = createDashboards(meta)

  app.all(`${DASHBOARDS_PATH}/*`, async (c) => {
    if (!dashboards) return fail(c, 404, "Dashboards need a Postgres database.")
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const role = await workspaceRole(c)
    if (!role) return fail(c, 403, "forbidden")
    const visible = await visibleArtifactsInWorkspace(meta, { orgId: org, viewerId: me.id })
    const artifacts = visible.map((a) => a.id)
    const viewer = dashboardsViewer({ userId: me.id, orgId: org, role, artifacts })
    return dashboards.handle(c.req.raw, viewer)
  })
  return app
}
