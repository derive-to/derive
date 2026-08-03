import { createFileRoute, redirect } from "@tanstack/react-router"

// Starred documents are a filter on the home library, not a feed of their own — so this
// path redirects into it. Kept because it was a route for a long time: bookmarks, and
// links already shared, should land on the list rather than a 404.
export const Route = createFileRoute("/favorites")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { filter: "starred" as const }, replace: true })
  },
})
