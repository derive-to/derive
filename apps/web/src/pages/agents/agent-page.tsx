import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { type AgentDetail, ApiError, api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { agentQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentJobs } from "./agent-jobs"
import { AgentSettings } from "./agent-settings"
import { AgentPending } from "./skeleton"
import { useMemberNames } from "./use-member-names"

const route = getRouteApi("/agents/$id")

// One agent: Jobs (what it is doing and has done) and Settings (everything about it that
// can be changed). The tab rides the URL so the MCP tool's `?tab=settings` link lands there.
export function AgentPage() {
  const { id } = route.useParams()
  const { tab } = route.useSearch()
  const navigate = route.useNavigate()
  const { me } = useAuth()
  const q = useQuery(agentQuery(id))
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

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        title={agent.name}
        titleTestId="agent-title"
        actions={
          agent.can_ask && <AskButton agent={agent} onAsked={() => navigate({ search: {} })} />
        }
      />
      <Tabs
        value={tab ?? "jobs"}
        onValueChange={(v) =>
          void navigate({ search: v === "settings" ? { tab: "settings" } : {} })
        }
      >
        <TabsList variant="line" aria-label="Agent views">
          <TabsTrigger value="jobs" data-testid="agent-tab-jobs">
            Jobs
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="agent-tab-settings">
            Settings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="jobs" className="pt-7">
          <AgentJobs agent={agent} names={names} meId={me.id} />
        </TabsContent>
        <TabsContent value="settings" className="pt-7">
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

/** The screen's one primary button: ask the agent for something, which opens a job. */
function AskButton({ agent, onAsked }: { agent: AgentDetail; onAsked: () => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const ask = useApiMutation({
    mutationFn: () => api.askAgent(agent.id, text.trim()),
    invalidate: [["jobs"]],
    onSuccess: () => {
      setOpen(false)
      setText("")
      onAsked()
    },
  })
  return (
    <>
      <Button type="button" size="sm" data-testid="agent-ask" onClick={() => setOpen(true)}>
        Ask
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Ask {agent.name}</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (text.trim()) ask.mutate()
            }}
          >
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) ask.mutate()
              }}
              aria-label="What to ask"
              data-testid="agent-ask-input"
              className="min-h-28"
            />
            <DialogFooter>
              <Button
                type="submit"
                size="sm"
                data-testid="agent-ask-send"
                disabled={!text.trim()}
                loading={ask.isPending}
              >
                Ask
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
