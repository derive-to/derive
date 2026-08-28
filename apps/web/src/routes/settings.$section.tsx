import { createFileRoute, redirect } from "@tanstack/react-router"
import { Settings } from "../pages/settings"
import { SECTION_ALIASES } from "../pages/settings/section-aliases"

// A settings section as a path segment: /settings/$section (profile, members,
// integrations…). Transient integration callback signals ride as query params — they're a
// one-shot handshake, not a place. The passthrough validator keeps them from being stripped
// before the relevant section consumes them.
//
// beforeLoad rewrites stale addresses instead of letting them strand on the
// Profile fallback: old/misspelled ids via SECTION_ALIASES, and /settings/people —
// the directory that once lived here — back out to /people.
export const Route = createFileRoute("/settings/$section")({
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> => ({ ...search }),
  beforeLoad: ({ params }) => {
    if (params.section === "people") throw redirect({ to: "/people", replace: true })
    if (params.section === "automations") throw redirect({ to: "/workflows", replace: true })
    const alias = SECTION_ALIASES[params.section]
    if (alias) {
      throw redirect({ to: "/settings/$section", params: { section: alias }, replace: true })
    }
  },
  component: Settings,
})
