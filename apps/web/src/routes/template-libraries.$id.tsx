import { createFileRoute } from "@tanstack/react-router"
import { PublicTemplateLibrary } from "../pages/templates/public-library"

// Public libraries are a lightweight sharing surface: anonymous visitors can
// inspect public starters and are directed through sign-in before making a copy.
export const Route = createFileRoute("/template-libraries/$id")({
  validateSearch: (search: Record<string, unknown>): { use?: string } => ({
    use:
      typeof search.use === "string" && /^[a-zA-Z0-9_-]+$/.test(search.use)
        ? search.use
        : undefined,
  }),
  component: PublicTemplateLibrary,
})
