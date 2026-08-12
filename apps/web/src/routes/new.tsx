import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { NewArtifact } from "../pages/new"
import type { NewArtifactSearch } from "../pages/templates/types"

// Create a new artifact with the same editor as edit mode (SourceEditor).
export const Route = createFileRoute("/new")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    const { template, library, entry, source, start } = args.search
    if (template) throw redirect({ to: "/templates", search: { use: template }, replace: true })
    if (library && entry)
      throw redirect({
        to: "/template-libraries/$id",
        params: { id: library },
        search: { use: entry },
        replace: true,
      })
    if (source) throw redirect({ to: "/templates", search: { source }, replace: true })
    if (start === "deck")
      throw redirect({
        to: "/templates",
        search: { tab: "artifacts", category: "Deck" },
        replace: true,
      })
  },
  validateSearch: (search: Record<string, unknown>): NewArtifactSearch => ({
    start: search.start === "deck" ? "deck" : undefined,
    template: typeof search.template === "string" ? search.template : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    library: typeof search.library === "string" ? search.library : undefined,
    entry: typeof search.entry === "string" ? search.entry : undefined,
    next: search.next === "context" ? "context" : undefined,
    contextName: typeof search.contextName === "string" ? search.contextName : undefined,
  }),
  component: NewArtifact,
})
