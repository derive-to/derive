import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Templates } from "../pages/templates"
import type { TemplatesSearch, TemplateTab } from "../pages/templates/types"

const TABS: TemplateTab[] = ["artifacts", "libraries"]

export const Route = createFileRoute("/templates")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    tab: TABS.includes(search.tab as TemplateTab) ? (search.tab as TemplateTab) : undefined,
    query: typeof search.query === "string" ? search.query : undefined,
    derive: search.derive === true || search.derive === "true" ? true : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    library: typeof search.library === "string" ? search.library : undefined,
  }),
  component: Templates,
})
