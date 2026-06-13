import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api, type Report } from "@/api"
import { useToast } from "@/components"
import { AppShell } from "@/components/app-shell"
import { CenteredSpinner } from "@/components/shared/spinner"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { AgentsSection } from "./agents-section"
import { ReportsSection } from "./reports-section"
import { WebhooksSection } from "./webhooks-section"
import { WorkspaceSection } from "./workspace-section"

export function Settings() {
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const { toast, show } = useToast()
  const [reports, setReports] = useState<Report[] | null>(null)

  useEffect(() => {
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])

  const loadReports = () =>
    api
      .listReports()
      .then((r) => setReports(r.reports))
      .catch(() => setReports([]))
  useEffect(() => {
    if (me) loadReports()
  }, [me])

  if (!me) return <CenteredSpinner />

  // Reports are urgent + owner-only — surface a tab only when there are open ones.
  const openReports = reports ?? []
  const hasReports = openReports.length > 0

  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto max-w-3xl px-5 pb-16 pt-7">
          <h1 className="font-display text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your workspace, members, and integrations.
          </p>

          <Tabs defaultValue="workspace" className="mt-6">
            <TabsList className="max-w-full overflow-x-auto">
              <TabsTrigger data-testid="settings-tab-workspace" value="workspace">
                Workspace
              </TabsTrigger>
              <TabsTrigger data-testid="settings-tab-webhooks" value="webhooks">
                Webhooks
              </TabsTrigger>
              <TabsTrigger data-testid="settings-tab-agents" value="agents">
                Agents
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
              <WorkspaceSection meId={me.id} show={show} />
            </TabsContent>
            <TabsContent value="webhooks">
              <WebhooksSection show={show} />
            </TabsContent>
            <TabsContent value="agents">
              <AgentsSection show={show} />
            </TabsContent>
            {hasReports && (
              <TabsContent value="reports">
                <ReportsSection reports={openReports} reload={loadReports} show={show} />
              </TabsContent>
            )}
          </Tabs>
        </main>
      </div>
      {toast}
    </AppShell>
  )
}
