import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { NewArtifact } from "../pages/new"
import type { NewArtifactSearch } from "../pages/templates/types"

// Create a new artifact with the same editor as edit mode (SourceEditor).
export const Route = createFileRoute("/new")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): NewArtifactSearch => ({
    start: search.start === "deck" ? "deck" : undefined,
    template: typeof search.template === "string" ? search.template : undefined,
    theme: typeof search.theme === "string" ? search.theme : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    library: typeof search.library === "string" ? search.library : undefined,
    entry: typeof search.entry === "string" ? search.entry : undefined,
    next: search.next === "context" ? "context" : undefined,
    contextName: typeof search.contextName === "string" ? search.contextName : undefined,
  }),
  component: NewArtifact,
})
