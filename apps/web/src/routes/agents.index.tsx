import { createFileRoute } from "@tanstack/react-router"
import { agentsQuery, openJobsQuery, recentJobsQuery, workspaceQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { AgentsHome } from "../pages/agents"
import { AgentsPending } from "../pages/agents/skeleton"

export const Route = createFileRoute("/agents/")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): { tab?: "tasks" | "usage" } =>
    search.tab === "tasks" || search.tab === "usage" ? { tab: search.tab } : {},
  loader: ({ context }) => {
    // History and member names enrich the roster; a slow read must not hold the page.
    void context.queryClient.prefetchQuery(recentJobsQuery())
    void context.queryClient.prefetchQuery(workspaceQuery())
    return Promise.all([
      context.queryClient.ensureQueryData(agentsQuery()).catch(() => {}),
      context.queryClient.ensureQueryData(openJobsQuery()).catch(() => {}),
    ])
  },
  pendingComponent: AgentsPending,
  component: AgentsHome,
})
