import { createFileRoute } from "@tanstack/react-router"
import { Templates } from "../pages/templates"
import type { TemplatesSearch, TemplateTab } from "../pages/templates/types"

const TABS: TemplateTab[] = ["artifacts", "libraries"]

// No auth guard on purpose: the shelf is public, and the page picks its frame by session.
export const Route = createFileRoute("/templates/")({
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    tab: TABS.includes(search.tab as TemplateTab) ? (search.tab as TemplateTab) : undefined,
    query: typeof search.query === "string" ? search.query : undefined,
    derive: search.derive === true || search.derive === "true" ? true : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    library: typeof search.library === "string" ? search.library : undefined,
  }),
  component: Templates,
})
