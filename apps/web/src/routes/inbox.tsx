import { createFileRoute } from "@tanstack/react-router"
import { agentsQuery, inboxJobsQuery, workspaceActivityQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { AgentsPending } from "../pages/agents/skeleton"
import { Inbox } from "../pages/inbox"

export const Route = createFileRoute("/inbox")({
  beforeLoad: requireOnboarded,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(inboxJobsQuery()).catch(() => {}),
      context.queryClient.prefetchQuery(agentsQuery()),
      context.queryClient.prefetchQuery(workspaceActivityQuery()),
    ]),
  pendingComponent: AgentsPending,
  component: Inbox,
})
