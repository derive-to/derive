import { createFileRoute } from "@tanstack/react-router"
import { Settings } from "../pages/settings"

// A settings section as a path segment: /settings/$section (profile, members, github…).
// The transient GitHub-install signals (gh_install / gh_error) still ride as query
// params — they're a one-shot handshake, not a place — and are read from
// window.location by the GitHub section. The passthrough validator keeps them from
// being stripped off the URL before that section consumes them.
export const Route = createFileRoute("/settings/$section")({
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> => ({ ...search }),
  component: Settings,
})
