import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { PageShell } from "@/components/shared/page-shell"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/ctx"
import { reportsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentsSection } from "./agents-section"
import { AppearanceSection } from "./appearance-section"
import { AutomationsSection } from "./automations-section"
import { CustomDomainsSection } from "./custom-domains-section"
import { GeneralSection } from "./general-section"
import { GithubSection } from "./github-section"
import { IntegrationsSection } from "./integrations-section"
import { MembersSection } from "./members-section"
import { ProfileSection } from "./profile-section"
import { ReportsSection } from "./reports-section"
import { SecuritySection } from "./security-section"
import { SettingsNav, type SettingsNavGroup } from "./settings-nav"
import { SourcesSection } from "./sources-section"
import { WebhooksSection } from "./webhooks-section"

// The active section rides the URL path (/settings/$section); getRouteApi avoids a
// circular import back to routes/settings.$section.tsx while still giving typed
// useParams/useNavigate.
const route = getRouteApi("/settings/$section")

// Tab titles per section — keep in step with the nav `groups` in Settings below.
const SECTION_TITLES: Record<string, string> = {
  profile: "Profile",
  security: "Security",
  appearance: "Appearance",
  general: "General",
  members: "Members",
  integrations: "Integrations",
  sources: "Sources",
  github: "GitHub",
  webhooks: "Webhooks",
  agents: "Agents",
  automations: "Automations",
  domains: "Domains",
  reports: "Reports",
}

// Settings, reconceived as a scope-grouped two-pane: a sticky category rail
// (Account · Workspace · Developer · Moderation) beside a readable detail column,
// reflowing to a horizontal strip on a narrow pane. The active section is a path
// segment (/settings/$section) — deep-linkable, back-button-friendly, and a peer of
// the server's own /settings/github/app/* pages — and the GitHub App install lands on
// `/settings/github?gh_install=…`. AppShell gates auth, so `me` is present whenever
// Settings renders.
export function Settings() {
  const { me } = useAuth()
  const qc = useQueryClient()
  const { data: reports } = useQuery({ ...reportsQuery(), enabled: !!me })
  const { section } = route.useParams()
  const nav = route.useNavigate()

  // Before the early return (hooks). Labels mirror the groups below — a static
  // map because the groups themselves are gated on data (`reports`).
  useDocumentTitle(SECTION_TITLES[section] ? `${SECTION_TITLES[section]} · Settings` : "Settings")

  if (!me) return null

  // Reports are urgent + owner-only — surface the section only while open ones exist.
  const openReports = reports ?? []
  const hasReports = openReports.length > 0

  const groups: SettingsNavGroup[] = [
    {
      label: "Account",
      items: [
        { id: "profile", label: "Profile", testId: "settings-tab-profile" },
        { id: "security", label: "Security", testId: "settings-tab-security" },
        { id: "appearance", label: "Appearance", testId: "settings-tab-appearance" },
      ],
    },
    {
      label: "Workspace",
      items: [
        { id: "general", label: "General", testId: "settings-tab-general" },
        { id: "members", label: "Members", testId: "settings-tab-members" },
        { id: "integrations", label: "Integrations", testId: "settings-tab-integrations" },
        { id: "sources", label: "Sources", testId: "settings-tab-sources" },
      ],
    },
    {
      label: "Developer",
      items: [
        { id: "github", label: "GitHub", testId: "settings-tab-github" },
        { id: "webhooks", label: "Webhooks", testId: "settings-tab-webhooks" },
        { id: "agents", label: "Agents", testId: "settings-tab-agents" },
        { id: "automations", label: "Automations", testId: "settings-tab-automations" },
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

  // Guard the `$section` against unknown/stale values (e.g. `reports` after the last
  // report clears, or a hand-typed path) — fall back to Profile so the pane never
  // strands blank.
  const ids = groups.flatMap((g) => g.items.map((i) => i.id))
  const active = ids.includes(section) ? section : "profile"
  const select = (id: string) => nav({ to: "/settings/$section", params: { section: id } })

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
            {active === "security" && <SecuritySection />}
            {active === "appearance" && <AppearanceSection />}
            {active === "general" && <GeneralSection />}
            {active === "members" && <MembersSection meId={me.id} />}
            {active === "integrations" && <IntegrationsSection />}
            {active === "sources" && <SourcesSection />}
            {active === "github" && <GithubSection />}
            {active === "webhooks" && <WebhooksSection />}
            {active === "agents" && <AgentsSection />}
            {active === "automations" && <AutomationsSection />}
            {active === "domains" && <CustomDomainsSection />}
            {active === "reports" && (
              <ReportsSection
                reports={openReports}
                reload={() => qc.invalidateQueries({ queryKey: reportsQuery().queryKey })}
              />
            )}
          </div>
        </div>
      </div>
    </PageShell>
  )
}
