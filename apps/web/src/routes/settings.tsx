import { createFileRoute } from "@tanstack/react-router"
import { Settings } from "../pages/settings"

export const Route = createFileRoute("/settings")({
  component: Settings,
  // Identity validator: types an optional `?tab=` (so a typed Link can deep-link to a
  // tab, e.g. the sync chip → GitHub) while preserving any other params the GitHub
  // install redirect lands with (gh_install / gh_error, read from window.location).
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: string } & Record<string, unknown> => ({
    ...search,
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
})
