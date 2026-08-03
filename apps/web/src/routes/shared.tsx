import { createFileRoute, redirect } from "@tanstack/react-router"

// "Shared with me" is a filter on the home library now, not a feed of its own. The path
// stays so existing bookmarks and already-shared links resolve.
export const Route = createFileRoute("/shared")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { filter: "shared" as const }, replace: true })
  },
})
