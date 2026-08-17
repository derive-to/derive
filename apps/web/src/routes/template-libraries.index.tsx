import { createFileRoute } from "@tanstack/react-router"
import { PublicTemplateLibraryCatalog } from "../pages/templates/public-library"

// The public discovery surface intentionally reads the same public-scope
// libraries as the signed-in catalog; there is no marketplace-only object type.
export const Route = createFileRoute("/template-libraries/")({
  component: PublicTemplateLibraryCatalog,
})
