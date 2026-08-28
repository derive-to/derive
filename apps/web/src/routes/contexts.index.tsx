import { createFileRoute } from "@tanstack/react-router"
import { contextsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Contexts } from "../pages/context"
import { ContextsPending } from "../pages/context/context-skeleton"
import type { ContextsSearch } from "../pages/templates/types"

export const Route = createFileRoute("/contexts/")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): ContextsSearch => ({
    manifest: typeof search.manifest === "string" ? search.manifest : undefined,
    name: typeof search.name === "string" ? search.name : undefined,
    origin: typeof search.origin === "string" ? search.origin : undefined,
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(contextsQuery()).catch(() => {}),
  pendingComponent: ContextsPending,
  component: Contexts,
})
