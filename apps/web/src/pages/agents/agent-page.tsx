import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { useRef } from "react"
import { type AgentDetail, type AgentTrigger, ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { agentQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentPages } from "./agent-artifacts"
import { AgentJobs } from "./agent-jobs"
import { AgentSettings } from "./agent-settings"
import { AgentSkill } from "./agent-skill"
import { cronLabel, isScheduled, nextRun, whenNext, zoneLabel } from "./format"
import { NewTaskDialog } from "./new-task-dialog"
import { Verb } from "./rows"
import { ShareAgentDialog } from "./share-agent-dialog"
import { AgentPending } from "./skeleton"
import { TaskComposer } from "./task-composer"
import { useMemberNames } from "./use-member-names"

const route = getRouteApi("/agents/$id")

// Agent views ride the URL. Existing MCP links to Settings keep their destination.
//
// The page has two shapes with one grammar. An agent people ask leads with the ask box: it is
// the page's one filled button. An agent a schedule runs leads with that schedule and whatever
// it is waiting on; asking it is a quiet verb in the header.
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
  const scheduled = isScheduled(agent.triggers)

  return (
    <PageShell width="wide" className="flex min-h-full flex-col gap-6 bg-card">
      <PageHeader
        actions={
          <div className="flex items-center gap-1">
            {scheduled && agent.can_ask && <NewTaskDialog agent={agent} quiet />}
            <ShareAgentDialog agent={agent} />
          </div>
        }
        title={agent.name}
        titleTestId="agent-title"
        eyebrow={
          <Link to="/agents" search={{}} data-testid="agent-back" className="hover:underline">
            All agents
          </Link>
        }
        subtitle={agent.description ?? undefined}
      />
      {(scheduled || agent.paused) && (
        <div className="flex flex-col gap-1.5">
          {agent.triggers
            .filter((t) => t.enabled)
            .map((t) => (
              <ScheduleLine key={t.id} agent={agent} trigger={t} />
            ))}
          <AgentPages agent={agent} />
        </div>
      )}
      {!scheduled && !agent.paused && <AgentPages agent={agent} />}
      {!scheduled && agent.can_ask && <TaskComposer agent={agent} />}
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

/** One enabled trigger in words, with when it next fires and a verb to run it now. "Run now"
 *  asks the agent the schedule's instruction, so the run reads like any other task. */
function ScheduleLine({ agent, trigger }: { agent: AgentDetail; trigger: AgentTrigger }) {
  const navigate = useNavigate()
  const key = useRef(crypto.randomUUID())
  // Only a schedule can be run by hand, and only one whose subject an ask can carry: an
  // event trigger's instruction assumes the event, a collection or tag subject has no ask.
  const raw = trigger.subject as { kind?: string; id?: string } | null
  const subject =
    raw?.kind === "artifact" && typeof raw.id === "string"
      ? { kind: "artifact" as const, id: raw.id }
      : undefined
  const runnable = trigger.kind === "schedule" && (!raw || !!subject)
  const run = useApiMutation({
    mutationFn: () =>
      api.askAgent(agent.id, trigger.instruction, subject, { dedupe_key: key.current }),
    invalidate: [["jobs"], ["agents"]],
    onSuccess: (job) => {
      key.current = crypto.randomUUID()
      void navigate({ to: "/tasks/$id", params: { id: job.id } })
    },
  })
  const next = trigger.cron ? nextRun(trigger.cron, trigger.tz) : null
  const zone = trigger.cron ? zoneLabel(trigger.tz) : null
  return (
    <div
      data-testid={`agent-schedule-${trigger.id}`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
    >
      <Icon name="agent-scheduled" size={15} strokeWidth={1.75} className="shrink-0" />
      <span data-testid="agent-schedule">
        {trigger.kind === "schedule" && trigger.cron
          ? `${cronLabel(trigger.cron)}${zone ? ` ${zone}` : ""}`
          : "On an event"}
        {agent.paused ? " · Paused" : next ? ` · Next ${whenNext(next)}` : ""}
      </span>
      {runnable && agent.can_ask && !agent.paused && (
        <Verb
          testId={`agent-run-now-${trigger.id}`}
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? "Starting…" : "Run now"}
        </Verb>
      )}
    </div>
  )
}
