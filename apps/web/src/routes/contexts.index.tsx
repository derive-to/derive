import { createFileRoute } from "@tanstack/react-router"
import { contextsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Contexts } from "../pages/context"
import { ContextsPending } from "../pages/context/context-skeleton"

// The contexts directory: /contexts — the workspace's askable agent setups.
export const Route = createFileRoute("/contexts/")({
  beforeLoad: requireOnboarded,
  // Best-effort warm for a deterministic first paint; a failed preload must NOT blank the
  // page behind the route error boundary — the component owns the shape-matched error.
  loader: ({ context }) => context.queryClient.ensureQueryData(contextsQuery()).catch(() => {}),
  pendingComponent: ContextsPending,
  component: Contexts,
})
