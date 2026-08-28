import { createFileRoute } from "@tanstack/react-router"
import { contextQuery, contextSessionsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { ContextConsole } from "../pages/context/console"
import { ConsolePending } from "../pages/context/context-skeleton"

export const Route = createFileRoute("/contexts/$id")({
  beforeLoad: requireOnboarded,
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.prefetchQuery(contextQuery(params.id)),
      context.queryClient.prefetchInfiniteQuery(contextSessionsQuery(params.id)),
    ]),
  pendingComponent: ConsolePending,
  component: ContextConsole,
})
