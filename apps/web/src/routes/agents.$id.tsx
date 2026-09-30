import { createFileRoute } from "@tanstack/react-router"
import { agentJobsQuery, agentQuery, workspaceQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { AgentPage } from "../pages/agents/agent-page"
import { AgentPending } from "../pages/agents/skeleton"

export const Route = createFileRoute("/agents/$id")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): { tab?: "settings" } =>
    search.tab === "settings" ? { tab: "settings" } : {},
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(agentQuery(params.id)).catch(() => {}),
      context.queryClient.prefetchInfiniteQuery(agentJobsQuery(params.id)),
      context.queryClient.prefetchQuery(workspaceQuery()),
    ]),
  pendingComponent: AgentPending,
  component: AgentPage,
})
