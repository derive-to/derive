import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { ContextBuilderPage } from "../pages/context/builder"
import type { NewContextSearch } from "../pages/templates/types"

export const Route = createFileRoute("/contexts/new")({
  beforeLoad: requireOnboarded,
  // `?door=arxiv&arxiv=<link>` opens the paper door prefilled (the Templates page and a
  // shared link land here); everything else is the guided builder.
  validateSearch: (search: Record<string, unknown>): NewContextSearch => ({
    door: search.door === "arxiv" ? "arxiv" : undefined,
    arxiv: typeof search.arxiv === "string" ? search.arxiv.slice(0, 2000) : undefined,
  }),
  component: ContextBuilderPage,
})
