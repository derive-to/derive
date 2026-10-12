import { createFileRoute } from "@tanstack/react-router"
import { jobQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { TaskPage, TaskPagePending } from "../pages/agents/task-page"

export const Route = createFileRoute("/tasks/$id")({
  beforeLoad: requireOnboarded,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(jobQuery(params.id)).catch(() => {}),
  component: Page,
  pendingComponent: TaskPagePending,
})
function Page() {
  const { id } = Route.useParams()
  return <TaskPage key={id} id={id} />
}
