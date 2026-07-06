import { createFileRoute, redirect } from "@tanstack/react-router"

// Drafts moved into the home library as a tab (decided on the sidebar-cleanup
// plan): a lifecycle state of your own work is a filter on All artifacts, not a
// rail-level feed. This route survives purely as a redirect so deep links and
// the agent's "open this draft's home" fallback keep working.
export const Route = createFileRoute("/unlisted")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { tab: "drafts" } })
  },
})
