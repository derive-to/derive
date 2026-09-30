import { createFileRoute } from "@tanstack/react-router"
import { agentsQuery, openJobsQuery, recentJobsQuery, workspaceQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { AgentsHome } from "../pages/agents"
import { AgentsPending } from "../pages/agents/skeleton"

export const Route = createFileRoute("/agents/")({
  beforeLoad: requireOnboarded,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(agentsQuery()).catch(() => {}),
      context.queryClient.ensureQueryData(openJobsQuery()).catch(() => {}),
      context.queryClient.prefetchQuery(recentJobsQuery()),
      context.queryClient.prefetchQuery(workspaceQuery()),
    ]),
  pendingComponent: AgentsPending,
  component: AgentsHome,
})
