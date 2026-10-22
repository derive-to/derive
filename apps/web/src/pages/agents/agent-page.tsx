import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { ApiError } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { agentQuery, workspaceQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentJobs } from "./agent-jobs"
import { AgentSettings } from "./agent-settings"
import { AgentSkill } from "./agent-skill"
import { machineOf, modelChoices } from "./format"
import { NewTaskDialog } from "./new-task-dialog"
import { AgentPending } from "./skeleton"
import { useMemberNames } from "./use-member-names"

const route = getRouteApi("/agents/$id")

// Agent views ride the URL. Existing MCP links to Settings keep their destination.
export function AgentPage() {
  const { id } = route.useParams()
  const { tab } = route.useSearch()
  const navigate = route.useNavigate()
  const { me } = useAuth()
  // Refetched on a timer so seen_at stays fresh and "machine off" is never a stale guess.
  const q = useQuery({ ...agentQuery(id), refetchInterval: 30_000 })
  const workspace = useQuery(workspaceQuery())
  const names = useMemberNames()
  useDocumentTitle(q.data?.name ?? "Agent")

  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <PageShell width="wide">
          <StatusPanel
            title="No such agent in this workspace."
            action={
              <Button asChild variant="outline" size="sm" data-testid="agent-missing-back">
                <Link to="/agents">All agents</Link>
              </Button>
            }
          />
        </PageShell>
      )
    return (
      <PageShell width="wide">
        <LoadError
          title="Couldn’t load this agent."
          testId="agent-retry"
          onRetry={() => void q.refetch()}
        />
      </PageShell>
    )
  }
  if (q.isPending || !me) return <AgentPending />
  const agent = q.data
  const schedules = agent.triggers.filter((t) => t.kind === "schedule" && t.enabled).length

  return (
    <PageShell width="wide" className="flex min-h-full flex-col gap-6 bg-card">
      <PageHeader
        actions={agent.can_ask ? <NewTaskDialog agent={agent} /> : undefined}
        title={agent.name}
        titleTestId="agent-title"
        eyebrow={
          <Link to="/agents" search={{}} data-testid="agent-back" className="hover:underline">
            All agents
          </Link>
        }
        subtitle={agent.description ?? undefined}
      />
      <p data-testid="agent-run-config" className="text-sm text-muted-foreground">
        {agent.machine === "derive"
          ? `Cloud · ${agent.runtime?.provider === "boat" ? "boat.dev" : "Ortam"}`
          : machineOf(agent, names).label}
        {" · "}
        {modelChoices(agent.provider).find((choice) => choice.id === agent.model)?.label ??
          agent.model ??
          "Account default"}
        {schedules > 0 && ` · ${schedules} active ${schedules === 1 ? "schedule" : "schedules"}`}
        {agent.max_run_ms !== null && ` · ${Math.round(agent.max_run_ms / 60_000)} min maximum`}
      </p>
      {workspace.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load this workspace’s members."
          testId="agent-workspace-retry"
          onRetry={() => void workspace.refetch()}
        />
      )}
      <Tabs
        value={tab === "skill" ? "settings" : (tab ?? "jobs")}
        onValueChange={(v) =>
          void navigate({
            search: v === "settings" || v === "skill" || v === "usage" ? { tab: v } : {},
          })
        }
      >
        <TabsList variant="line" aria-label="Agent views">
          <TabsTrigger value="jobs" data-testid="agent-tab-jobs">
            Tasks
          </TabsTrigger>
          <TabsTrigger value="usage" data-testid="agent-tab-usage">
            Usage
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="agent-tab-settings">
            Settings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="jobs" className="flex flex-col gap-7 pt-5">
          <AgentJobs agent={agent} names={names} meId={me.id} />
        </TabsContent>
        <TabsContent value="usage" className="pt-5">
          <AgentJobs agent={agent} names={names} meId={me.id} usage />
        </TabsContent>
        <TabsContent value="settings" className="flex flex-col gap-8 pt-7">
          {agent.instructions_short_id && (
            <details
              open={tab === "skill" ? true : undefined}
              data-testid="agent-instructions-preview"
              className="rounded-lg border border-border p-4"
            >
              <summary className="cursor-pointer text-sm font-medium">
                Instructions · preview and edit
              </summary>
              <div className="pt-4">
                <AgentSkill agent={agent} />
              </div>
            </details>
          )}
          <AgentSettings
            // Remount on a server change so the form fields re-seed from the saved values.
            key={`${agent.name}\u0000${agent.description ?? ""}`}
            agent={agent}
            names={names}
            workspaceName={workspace.data?.name ?? ""}
            isWorkspaceOwner={workspace.data?.role === "owner"}
          />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
