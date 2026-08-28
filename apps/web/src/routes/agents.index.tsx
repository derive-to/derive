import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import type { ContextsSearch } from "../pages/templates/types"

// Preserve links emitted while /agents was the public route.
export const Route = createFileRoute("/agents/")({
  validateSearch: (search: Record<string, unknown>): ContextsSearch => ({
    manifest: typeof search.manifest === "string" ? search.manifest : undefined,
    name: typeof search.name === "string" ? search.name : undefined,
    origin: typeof search.origin === "string" ? search.origin : undefined,
  }),
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/contexts", search: args.search, replace: true })
  },
})
