import { createFileRoute } from "@tanstack/react-router"
import { bootstrapQuery } from "../lib/bootstrap"
import { automationsQuery, workflowsQuery, workspaceQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Workflows, WorkflowsPending } from "../pages/workflows"

export const Route = createFileRoute("/workflows")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    view?: "definitions" | "runs" | "workflows"
    workflow?: string
    tab?: "configuration" | "runs"
  } => ({
    view:
      search.view === "definitions" || search.view === "browse"
        ? ("definitions" as const)
        : search.view === "runs"
          ? ("runs" as const)
          : search.view === "workflows"
            ? "workflows"
            : undefined,
    workflow: typeof search.workflow === "string" ? search.workflow : undefined,
    tab:
      search.tab === "configuration" ? "configuration" : search.tab === "runs" ? "runs" : undefined,
  }),
  beforeLoad: requireOnboarded,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(bootstrapQuery(context.queryClient)).catch(() => {}),
      context.queryClient.ensureQueryData(workspaceQuery()).catch(() => {}),
      context.queryClient.ensureQueryData(workflowsQuery()).catch(() => {}),
      context.queryClient.ensureQueryData(automationsQuery()).catch(() => {}),
    ]),
  pendingComponent: WorkflowsPending,
  component: Workflows,
})
