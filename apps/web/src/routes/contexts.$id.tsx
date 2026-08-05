import { createFileRoute } from "@tanstack/react-router"
import { contextQuery, contextSessionsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { ContextConsole } from "../pages/context/console"
import { ConsolePending } from "../pages/context/context-skeleton"

// One context's console: /contexts/$id — ask, read answers, follow up.
export const Route = createFileRoute("/contexts/$id")({
  beforeLoad: requireOnboarded,
  // Best-effort warm: the console owns the no-access + load-error states (a
  // teammate without an ask grant gets a 404), so a failed fetch here must NOT
  // surface as a route error — it would blank the page instead of explaining.
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.prefetchQuery(contextQuery(params.id)),
      // Sessions are paged (Activity is the full record, not the last 50), so the
      // warm-up is the infinite variant — prefetchQuery cannot seed a paged cache.
      context.queryClient.prefetchInfiniteQuery(contextSessionsQuery(params.id)),
    ]),
  pendingComponent: ConsolePending,
  component: ContextConsole,
})
