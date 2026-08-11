import { createFileRoute } from "@tanstack/react-router"
import { PublicTemplateLibrary } from "../pages/templates/public-library"

// Public libraries are a lightweight sharing surface: anonymous visitors can
// inspect public starters and are directed through sign-in before making a copy.
export const Route = createFileRoute("/template-libraries/$id")({
  component: PublicTemplateLibrary,
})
