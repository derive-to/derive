import { createFileRoute } from "@tanstack/react-router"
import { contextsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Agents } from "../pages/context"
import { AgentsPending } from "../pages/context/context-skeleton"
import type { ContextsSearch } from "../pages/templates/types"

// The product calls these reusable setups Agents. The API and query retain their
// context names until the compatibility contract is versioned.
export const Route = createFileRoute("/agents/")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): ContextsSearch => ({
    manifest: typeof search.manifest === "string" ? search.manifest : undefined,
    name: typeof search.name === "string" ? search.name : undefined,
    origin: typeof search.origin === "string" ? search.origin : undefined,
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(contextsQuery()).catch(() => {}),
  pendingComponent: AgentsPending,
  component: Agents,
})
