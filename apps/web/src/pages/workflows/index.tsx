import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { Icon } from "@/components/icons"
import { ExecutionReadiness } from "@/components/shared/execution-readiness"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { workflowRuntimesQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AutomatedWorkflows, RecentRuns } from "./automated-workflows"
import { AutomationForm } from "./automation-form"
import { CloudWorkflowDetail } from "./cloud-workflow-detail"
import { CloudWorkflows, NewCloudWorkflow } from "./cloud-workflows"
import { WorkflowDefinitions } from "./workflow-definitions"

export { visibleWorkflows } from "./workflow-definitions"

export function Workflows() {
  useDocumentTitle("Workflows")
  const search = useSearch({ from: "/workflows" })
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      {search.workflow ? (
        <>
          <Link
            to="/workflows"
            search={{ view: "workflows" }}
            className="self-start text-sm text-muted-foreground hover:text-foreground"
            data-testid="workflow-back"
          >
            ← All workflows
          </Link>
          <CloudWorkflowDetail key={search.workflow} id={search.workflow} />
        </>
      ) : (
        <WorkflowIndex />
      )}
    </PageShell>
  )
}

function WorkflowIndex() {
  const search = useSearch({ from: "/workflows" })
  const navigate = useNavigate({ from: "/workflows" })
  const [creating, setCreating] = useState(false)
  const workspace = useQuery(workspaceQuery())
  const cloud = useQuery(workflowRuntimesQuery())
  const settings = useQuery(workspaceSettingsQuery())
  if (workspace.isError || cloud.isError || settings.isError)
    return (
      <LoadError
        title="Couldn’t load workflow access"
        testId="workflow-index-retry"
        onRetry={() => {
          void workspace.refetch()
          void cloud.refetch()
          void settings.refetch()
        }}
      />
    )
  const owner = workspace.data?.role === "owner"
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Workflows"
        subtitle="Configure repeatable work, run it when needed, and review the results."
        actions={
          (owner || cloud.data?.can_create) && (
            <Button size="sm" data-testid="workflows-new" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New workflow
            </Button>
          )
        }
      />
      <Tabs
        value={search.view ?? "workflows"}
        onValueChange={(view) =>
          void navigate({
            search: {
              view: view === "definitions" ? "definitions" : view === "runs" ? "runs" : "workflows",
            },
          })
        }
      >
        <TabsList variant="line" aria-label="Workflow views">
          <TabsTrigger data-testid="workflows-view-schedules" value="workflows">
            Workflows
          </TabsTrigger>
          <TabsTrigger data-testid="workflows-view-runs" value="runs">
            Runs
          </TabsTrigger>
          <TabsTrigger data-testid="workflows-view-browse" value="definitions">
            Definitions
          </TabsTrigger>
        </TabsList>
        <TabsContent value="workflows" className="flex flex-col gap-6 pt-5">
          <ExecutionReadiness />
          <section className="flex flex-col gap-3">
            <SectionTitle>Cloud workflows</SectionTitle>
            <CloudWorkflows />
          </section>
          <section className="flex flex-col gap-3">
            <SectionTitle>Tasks and GitHub Actions</SectionTitle>
            <AutomatedWorkflows />
          </section>
        </TabsContent>
        <TabsContent value="runs" className="flex flex-col gap-5 pt-5">
          <RecentRuns />
        </TabsContent>
        <TabsContent value="definitions" className="pt-5">
          <WorkflowDefinitions />
        </TabsContent>
      </Tabs>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent
          className="max-h-screen overflow-y-auto sm:max-w-2xl"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
          </DialogHeader>
          <Tabs defaultValue={cloud.data?.can_create ? "cloud" : "task"}>
            <TabsList variant="line">
              <TabsTrigger
                value="cloud"
                disabled={!cloud.data?.can_create}
                data-testid="workflow-create-cloud"
              >
                Cloud agent
              </TabsTrigger>
              <TabsTrigger value="task" disabled={!owner} data-testid="workflow-create-task">
                Task or GitHub Action
              </TabsTrigger>
            </TabsList>
            <TabsContent value="cloud" className="pt-4">
              {cloud.data?.can_create && (
                <NewCloudWorkflow
                  onCreated={(id) => {
                    setCreating(false)
                    void navigate({ search: { workflow: id, tab: "configuration" } })
                  }}
                />
              )}
            </TabsContent>
            <TabsContent value="task" className="flex flex-col gap-4 pt-4">
              <ExecutionReadiness />
              {owner && settings.data?.automateBeta && (
                <AutomationForm onDone={() => setCreating(false)} />
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  )
}
export function WorkflowsPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-48 rounded-xl" />
    </PageShell>
  )
}
