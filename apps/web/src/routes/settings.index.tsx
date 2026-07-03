import { createFileRoute, redirect } from "@tanstack/react-router"

// /settings has no content of its own — the sections are the places. Land on the
// first section (Profile) so the pane is never blank; deep links go straight to a
// section (/settings/github, …).
export const Route = createFileRoute("/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "profile" } })
  },
})
