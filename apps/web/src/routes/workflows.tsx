import { createFileRoute } from "@tanstack/react-router"
import { automationsQuery, workflowsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Workflows, WorkflowsPending } from "../pages/workflows"

export const Route = createFileRoute("/workflows")({
  beforeLoad: requireOnboarded,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(workflowsQuery()).catch(() => {}),
      context.queryClient.ensureQueryData(automationsQuery()).catch(() => {}),
    ]),
  pendingComponent: WorkflowsPending,
  component: Workflows,
})
