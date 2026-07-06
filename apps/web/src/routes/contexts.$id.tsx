import { createFileRoute } from "@tanstack/react-router"
import { contextQuery, contextSessionsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { ContextConsole } from "../pages/context/console"

// One context's console: /contexts/$id — ask, read answers, follow up.
export const Route = createFileRoute("/contexts/$id")({
  beforeLoad: requireOnboarded,
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(contextQuery(params.id)),
      context.queryClient.prefetchQuery(contextSessionsQuery(params.id)),
    ]),
  component: ContextConsole,
})
