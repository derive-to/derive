import { createFileRoute, Outlet } from "@tanstack/react-router"

// Settings is a section-per-place area: /settings/profile, /settings/members,
// /settings/github, … Each section is a distinct place, so it's a path segment, not a
// ?tab= query — consistent with /favorites, /following, and the server's own
// /settings/github/app/* pages (docs/decisions/0002). This layout just hosts the
// section routes; the index redirects to the first section and $section renders one.
export const Route = createFileRoute("/settings")({
  component: () => <Outlet />,
})
