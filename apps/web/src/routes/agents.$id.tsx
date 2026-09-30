import { createFileRoute, redirect } from "@tanstack/react-router"
import { agentJobsQuery, agentQuery, workspaceQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { AgentPage } from "../pages/agents/agent-page"
import { AgentPending } from "../pages/agents/skeleton"

export const Route = createFileRoute("/agents/$id")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    // Old bookmarks: /agents/<id> used to open a Context. Contexts are gone and a context id
    // is never an agent id, so it lands on the Agents home.
    if (args.params.id.startsWith("ctx_")) throw redirect({ to: "/agents", replace: true })
  },
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
