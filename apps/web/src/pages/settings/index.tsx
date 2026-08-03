import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { PageShell } from "@/components/shared/page-shell"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/ctx"
import { chatModelsQuery, operatorQuery, reportsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentsSection } from "./agents-section"
import { AppearanceSection } from "./appearance-section"
import { AutomationsSection } from "./automations-section"
import { BillingSection } from "./billing-section"
import { BrandprintSettings } from "./brandprint-settings"
import { CustomDomainsSection } from "./custom-domains-section"
import { GeneralSection } from "./general-section"
import { GithubSection } from "./github-section"
import { IntegrationsSection } from "./integrations-section"
import { MembersSection } from "./members-section"
import { ModelPlansSection } from "./model-plans-section"
import { ModelsSection } from "./models-section"
import { PeopleSection } from "./people-section"
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
  "model-plans": "Model plans",
  appearance: "Appearance",
  general: "General",
  members: "Members",
  people: "People",
  billing: "Billing",
  integrations: "Integrations",
  sources: "Sources",
  brandprint: "Brandprint",
  github: "GitHub",
  webhooks: "Webhooks",
  agents: "Agents",
  automations: "Automations",
  domains: "Domains",
  reports: "Reports",
  models: "Chat model",
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
  // The catalog decides whether this workspace has a CHOICE to make. One configured model is a
  // fact about the deploy rather than a decision, so the section stays out of the way until an
  // operator has actually configured a second provider.
  const { data: catalog } = useQuery({ ...chatModelsQuery(), enabled: !!me })
  // Operator-only: the model is the operator's credential to spend, not a workspace's.
  const { isSuccess: isOperator } = useQuery({ ...operatorQuery(), enabled: !!me })
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
        { id: "model-plans", label: "Model plans", testId: "settings-tab-model-plans" },
        { id: "appearance", label: "Appearance", testId: "settings-tab-appearance" },
      ],
    },
    {
      label: "Workspace",
      items: [
        { id: "general", label: "General", testId: "settings-tab-general" },
        { id: "members", label: "Members", testId: "settings-tab-members" },
        { id: "people", label: "People", testId: "settings-tab-people" },
        { id: "billing", label: "Billing", testId: "settings-tab-billing" },
        { id: "integrations", label: "Integrations", testId: "settings-tab-integrations" },
        { id: "sources", label: "Sources", testId: "settings-tab-sources" },
        ...((isOperator && (catalog?.models.length ?? 0) > 1
          ? [{ id: "models", label: "Chat model", testId: "settings-tab-models" }]
          : []) as SettingsNavGroup["items"]),
        { id: "brandprint", label: "Brandprint", testId: "settings-tab-brandprint" },
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
            {active === "model-plans" && <ModelPlansSection />}
            {active === "appearance" && <AppearanceSection />}
            {active === "general" && <GeneralSection />}
            {active === "members" && <MembersSection meId={me.id} />}
            {active === "people" && <PeopleSection />}
            {active === "billing" && <BillingSection />}
            {active === "integrations" && <IntegrationsSection />}
            {active === "sources" && <SourcesSection />}
            {active === "brandprint" && <BrandprintSettings />}
            {active === "github" && <GithubSection />}
            {active === "webhooks" && <WebhooksSection />}
            {active === "agents" && <AgentsSection meId={me.id} />}
            {active === "automations" && <AutomationsSection />}
            {active === "domains" && <CustomDomainsSection />}
            {active === "models" && <ModelsSection />}
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
