import { useCallback, useEffect, useState } from "react"
import { api, type Report } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { AccountSection } from "./account-section"
import { AgentsSection } from "./agents-section"
import { CustomDomainsSection } from "./custom-domains-section"
import { GithubSection } from "./github-section"
import { ReportsSection } from "./reports-section"
import { WebhooksSection } from "./webhooks-section"
import { WorkspaceSection } from "./workspace-section"

export function Settings() {
  // AppShell (mounted once around the Outlet) gates auth, so `me` is present
  // whenever Settings renders.
  const { me } = useAuth()
  const [reports, setReports] = useState<Report[] | null>(null)
  const [tab, setTab] = useState("workspace")

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
  // The Reports tab only exists while there are open reports. If the last one is
  // cleared while it's the active tab, fall back to Workspace so the content
  // panel never strands blank with no tab selected.
  useEffect(() => {
    if ((reports?.length ?? 0) === 0 && tab === "reports") setTab("workspace")
  }, [reports, tab])

  if (!me) return null

  // Reports are urgent + owner-only — surface a tab only when there are open ones.
  const openReports = reports ?? []
  const hasReports = openReports.length > 0

  return (
    <div className="flex-1 overflow-y-auto">
      <main className="mx-auto max-w-3xl px-5 pb-16 pt-7">
        <h1 className="font-display text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your workspace, members, and integrations.
        </p>

        <Tabs value={tab} onValueChange={setTab} className="mt-6">
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger data-testid="settings-tab-workspace" value="workspace">
              Workspace
            </TabsTrigger>
            <TabsTrigger data-testid="settings-tab-account" value="account">
              Account
            </TabsTrigger>
            <TabsTrigger data-testid="settings-tab-webhooks" value="webhooks">
              Webhooks
            </TabsTrigger>
            <TabsTrigger data-testid="settings-tab-agents" value="agents">
              Agents
            </TabsTrigger>
            <TabsTrigger data-testid="settings-tab-github" value="github">
              GitHub
            </TabsTrigger>
            <TabsTrigger data-testid="settings-tab-domains" value="domains">
              Domains
            </TabsTrigger>
            {hasReports && (
              <TabsTrigger data-testid="settings-tab-reports" value="reports">
                Reports
                <Badge className="border-destructive bg-destructive text-destructive-foreground">
                  {openReports.length}
                </Badge>
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="workspace">
            <WorkspaceSection meId={me.id} />
          </TabsContent>
          <TabsContent value="account">
            <AccountSection />
          </TabsContent>
          <TabsContent value="webhooks">
            <WebhooksSection />
          </TabsContent>
          <TabsContent value="agents">
            <AgentsSection />
          </TabsContent>
          <TabsContent value="github">
            <GithubSection />
          </TabsContent>
          <TabsContent value="domains">
            <CustomDomainsSection />
          </TabsContent>
          {hasReports && (
            <TabsContent value="reports">
              <ReportsSection reports={openReports} reload={loadReports} />
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  )
}
