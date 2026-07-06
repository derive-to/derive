import { createFileRoute } from "@tanstack/react-router"
import { contextsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Contexts } from "../pages/context"

// The contexts directory: /contexts — the workspace's askable agent setups.
export const Route = createFileRoute("/contexts/")({
  beforeLoad: requireOnboarded,
  loader: ({ context }) => context.queryClient.ensureQueryData(contextsQuery()),
  component: Contexts,
})
