import { capRole } from "@derive/core"
import { addDashboardTools } from "derive-dashboards/mcp"
import { dashboardsFor, dashboardsViewer } from "../dashboards"
import { visibleArtifactsInWorkspace } from "../lib/visibility"
import type { ToolContext } from "../mcp-tool-context"

/**
 * dashboards_query (read only: ask about the workspace, the rows behind an answer, its
 * dashboards read out) and dashboards_api (every dashboards endpoint, edits to this agent's own
 * draft). Both act in the connection's default workspace, for the person the agent acts for,
 * through the same visibility gate as `find`; history credits the agent. Postgres only, like
 * the Dashboards page.
 */
export const registerDashboardsTools = (tc: ToolContext) => {
  const { ctx, server, agent, actingFor, defaultOrg, defaultRole, scopeForCap } = tc
  const dashboards = dashboardsFor(ctx.meta)
  if (!dashboards) return
  addDashboardTools(server, dashboards.server, {
    viewer: async () => {
      const person = actingFor?.id ?? agent.id
      const visible = await visibleArtifactsInWorkspace(ctx.meta, {
        orgId: defaultOrg,
        viewerId: person,
      })
      const role = capRole(defaultRole, scopeForCap)
      return {
        ...dashboardsViewer({
          userId: agent.id,
          orgId: defaultOrg,
          role,
          artifacts: visible.map((a) => a.id),
        }),
        agent: { for: person },
      }
    },
  })
}
