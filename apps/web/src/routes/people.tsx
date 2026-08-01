import { createFileRoute, redirect } from "@tanstack/react-router"

// The People directory moved into Settings → People. The path stays so bookmarks and
// already-shared links still resolve.
export const Route = createFileRoute("/people")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "people" }, replace: true })
  },
})
