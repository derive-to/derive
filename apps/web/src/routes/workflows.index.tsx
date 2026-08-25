import { createFileRoute } from "@tanstack/react-router"
import { contextsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import {
  WORKFLOW_VIEWS,
  Workflows,
  WorkflowsPending,
  type WorkflowsSearch,
  type WorkflowView,
} from "../pages/workflows"

export const Route = createFileRoute("/workflows/")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): WorkflowsSearch => ({
    view: WORKFLOW_VIEWS.includes(search.view as WorkflowView)
      ? (search.view as WorkflowView)
      : undefined,
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(contextsQuery()).catch(() => {})
  },
  pendingComponent: WorkflowsPending,
  component: Workflows,
})
