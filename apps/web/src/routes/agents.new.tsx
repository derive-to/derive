import { createFileRoute } from "@tanstack/react-router"
import { agentsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { NewAgent } from "../pages/agents/new-agent"
import { NewAgentPending } from "../pages/agents/skeleton"

export const Route = createFileRoute("/agents/new")({
  beforeLoad: requireOnboarded,
  loader: ({ context }) => context.queryClient.prefetchQuery(agentsQuery()),
  pendingComponent: NewAgentPending,
  component: NewAgent,
})
