import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import type { ContextsSearch } from "../pages/templates/types"

// Keep old bookmarks and links working while /agents is the canonical product route.
export const Route = createFileRoute("/contexts/")({
  validateSearch: (search: Record<string, unknown>): ContextsSearch => ({
    manifest: typeof search.manifest === "string" ? search.manifest : undefined,
    name: typeof search.name === "string" ? search.name : undefined,
    origin: typeof search.origin === "string" ? search.origin : undefined,
  }),
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/agents", search: args.search, replace: true })
  },
})
