import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { NewPaper } from "../pages/papers"

export const Route = createFileRoute("/papers/new")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>): { arxiv?: string } =>
    typeof search.arxiv === "string" ? { arxiv: search.arxiv } : {},
  component: NewPaper,
})
