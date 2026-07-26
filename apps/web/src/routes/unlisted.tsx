import { createFileRoute, redirect } from "@tanstack/react-router"

// The former "Drafts" tab is now "Created by me" — an authorship filter, not a
// visibility lifecycle state, so it lives in the home library as a tab rather
// than a rail-level feed. This route survives purely as a redirect so old deep
// links and the agent's "open this draft's home" fallback keep working.
export const Route = createFileRoute("/unlisted")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { tab: "mine" } })
  },
})
