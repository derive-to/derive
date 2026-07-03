import { getRouteApi } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { api, type Report } from "@/api"
import { PageShell } from "@/components/shared/page-shell"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/ctx"
import { AgentsSection } from "./agents-section"
import { AppearanceSection } from "./appearance-section"
import { CustomDomainsSection } from "./custom-domains-section"
import { GeneralSection } from "./general-section"
import { GithubSection } from "./github-section"
import { IntegrationsSection } from "./integrations-section"
import { MembersSection } from "./members-section"
import { ProfileSection } from "./profile-section"
import { ReportsSection } from "./reports-section"
import { SettingsNav, type SettingsNavGroup } from "./settings-nav"
import { WebhooksSection } from "./webhooks-section"

// The route owns the typed `?tab=` search; getRouteApi avoids a circular import
// back to routes/settings.tsx while still giving typed useSearch/useNavigate.
const route = getRouteApi("/settings")

// Settings, reconceived as a scope-grouped two-pane: a sticky category rail
// (Account · Workspace · Developer · Moderation) beside a readable detail column,
// reflowing to a horizontal strip on a narrow pane. The active section rides the
// URL's `?tab=` (deep-linkable, back-button-friendly) rather than the old local
// window.location hack — and the GitHub App install still lands on
// `/settings?tab=github&gh_install=…` unchanged. AppShell gates auth, so `me` is
// present whenever Settings renders.
export function Settings() {
  const { me } = useAuth()
  const [reports, setReports] = useState<Report[] | null>(null)
  const { tab } = route.useSearch()
  const nav = route.useNavigate()

  const loadReports = useCallback(
    () =>
      api
        .listReports()
        .then((r) => setReports(r.reports))
        .catch(() => setReports([])),
    [],
  )
  useEffect(() => {
    if (me) loadReports()
  }, [me, loadReports])

  if (!me) return null

  // Reports are urgent + owner-only — surface the section only while open ones exist.
  const openReports = reports ?? []
  const hasReports = openReports.length > 0

  const groups: SettingsNavGroup[] = [
    {
      label: "Account",
      items: [
        { id: "profile", label: "Profile", testId: "settings-tab-profile" },
        { id: "appearance", label: "Appearance", testId: "settings-tab-appearance" },
      ],
    },
    {
      label: "Workspace",
      items: [
        { id: "general", label: "General", testId: "settings-tab-general" },
        { id: "members", label: "Members", testId: "settings-tab-members" },
        { id: "integrations", label: "Integrations", testId: "settings-tab-integrations" },
      ],
    },
    {
      label: "Developer",
      items: [
        { id: "github", label: "GitHub", testId: "settings-tab-github" },
        { id: "webhooks", label: "Webhooks", testId: "settings-tab-webhooks" },
        { id: "agents", label: "Agents", testId: "settings-tab-agents" },
        { id: "domains", label: "Domains", testId: "settings-tab-domains" },
      ],
    },
  ]
  if (hasReports) {
    groups.push({
      label: "Moderation",
      items: [
        {
          id: "reports",
          label: "Reports",
          testId: "settings-tab-reports",
          badge: (
            <Badge variant="destructive" shape="pill">
              {openReports.length}
            </Badge>
          ),
        },
      ],
    })
  }

  // Guard the `?tab=` against unknown/stale values (e.g. `reports` after the last
  // report clears) — fall back to Profile so the pane never strands blank.
  const ids = groups.flatMap((g) => g.items.map((i) => i.id))
  const active = tab && ids.includes(tab) ? tab : "profile"
  const select = (id: string) => nav({ search: (prev) => ({ ...prev, tab: id }) })

  return (
    <PageShell width="wide">
      <div className="@container">
        <div className="flex flex-col gap-5 @2xl:grid @2xl:grid-cols-[12rem_minmax(0,1fr)] @2xl:gap-8">
          {/* The rail: page identity as a quiet mono eyebrow (the loud voice title
              is the active section, not "Settings"), then the scope-grouped nav.
              Sticky beside a scrolling detail column on a wide pane. */}
          <div className="@2xl:sticky @2xl:top-8 @2xl:self-start">
            <Eyebrow as="div" className="mb-3 hidden px-2 @2xl:block">
              Settings
            </Eyebrow>
            <SettingsNav groups={groups} value={active} onSelect={select} />
          </div>

          <div className="min-w-0">
            {active === "profile" && <ProfileSection />}
            {active === "appearance" && <AppearanceSection />}
            {active === "general" && <GeneralSection />}
            {active === "members" && <MembersSection meId={me.id} />}
            {active === "integrations" && <IntegrationsSection />}
            {active === "github" && <GithubSection />}
            {active === "webhooks" && <WebhooksSection />}
            {active === "agents" && <AgentsSection />}
            {active === "domains" && <CustomDomainsSection />}
            {active === "reports" && <ReportsSection reports={openReports} reload={loadReports} />}
          </div>
        </div>
      </div>
    </PageShell>
  )
}
