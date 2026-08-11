import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Templates } from "../pages/templates"
import type { TemplateCategory, TemplatesSearch, TemplateTab } from "../pages/templates/types"

const TABS: TemplateTab[] = ["artifacts", "contexts", "themes"]
const CATEGORIES: TemplateCategory[] = ["Deck", "Doc", "Report", "Site", "Agent"]

export const Route = createFileRoute("/templates")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    tab: TABS.includes(search.tab as TemplateTab) ? (search.tab as TemplateTab) : undefined,
    query: typeof search.query === "string" ? search.query : undefined,
    category: CATEGORIES.includes(search.category as TemplateCategory)
      ? (search.category as TemplateCategory)
      : undefined,
    selected: typeof search.selected === "string" ? search.selected : undefined,
    theme: typeof search.theme === "string" ? search.theme : undefined,
    derive: search.derive === true || search.derive === "true" ? true : undefined,
  }),
  component: Templates,
})
