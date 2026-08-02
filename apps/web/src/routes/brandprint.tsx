import { createFileRoute, redirect } from "@tanstack/react-router"

// Brandprint moved into Settings. The path stays so existing bookmarks and any links
// already shared land on it rather than a 404.
export const Route = createFileRoute("/brandprint")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "brandprint" }, replace: true })
  },
})
