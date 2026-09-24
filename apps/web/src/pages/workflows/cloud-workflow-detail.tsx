import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { contextQuery, contextRuntimeQuery } from "@/lib/queries"
import { ManagedRuntimeCard } from "../context/managed-runtime-card"
import { RuntimeAccessCard } from "../context/runtime-access-card"

export function CloudWorkflowDetail({ id }: { id: string }) {
  const context = useQuery(contextQuery(id))
  const runtime = useQuery({ ...contextRuntimeQuery(id), refetchInterval: 5000 })
  const search = useSearch({ from: "/workflows" })
  const navigate = useNavigate({ from: "/workflows" })
  if (context.isError || runtime.isError)
    return (
      <LoadError
        title="Couldn’t open this workflow"
        description="It may be unavailable, or you may not have permission to run it."
        testId="workflow-detail-retry"
        onRetry={() => {
          void context.refetch()
          void runtime.refetch()
        }}
      />
    )
  if (!context.data || !runtime.data) return <Skeleton className="h-48 rounded-xl" />
  if (!runtime.data.enabled || !runtime.data.managed)
    return (
      <p className="text-sm text-muted-foreground">
        Cloud execution is not available for this workflow in this workspace.
      </p>
    )
  const state = runtime.data
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={context.data.name}
        eyebrow="Workflow"
        subtitle="A saved task, its assigned agent, and the results of each run."
        actions={
          <Link
            to="/contexts/$id"
            params={{ id }}
            className="text-sm text-primary hover:underline"
            data-testid="workflow-context"
          >
            Context and skills
          </Link>
        }
      />
      <Tabs
        value={search.tab ?? "runs"}
        onValueChange={(tab) =>
          void navigate({
            search: (previous) => ({
              ...previous,
              tab: tab === "configuration" ? "configuration" : "runs",
            }),
          })
        }
      >
        <TabsList variant="line" aria-label="Workflow details">
          <TabsTrigger data-testid="workflow-detail-runs" value="runs">
            Runs
          </TabsTrigger>
          <TabsTrigger data-testid="workflow-detail-configuration" value="configuration">
            Configuration
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="pt-5">
          {!state.runtime || !state.schedule ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
              <p className="text-sm text-muted-foreground">
                {state.setup && state.setup.phase !== "failed"
                  ? "Preparing this workflow. You can leave and return when it is ready."
                  : "Finish account setup and save the task instructions before the first run."}
              </p>
              <Button
                data-testid="workflow-finish-setup"
                variant="secondary"
                size="sm"
                onClick={() =>
                  void navigate({ search: (previous) => ({ ...previous, tab: "configuration" }) })
                }
              >
                Open configuration
              </Button>
            </div>
          ) : null}
          <ManagedRuntimeCard contextId={id} state={state} view="runs" />
        </TabsContent>
        <TabsContent value="configuration" className="flex flex-col gap-5 pt-5">
          <ManagedRuntimeCard contextId={id} state={state} view="configuration" />
          {state.can_edit && <RuntimeAccessCard context={context.data} />}
          <p className="text-sm text-muted-foreground">
            {context.data.ask_policy === "workspace"
              ? "Workspace members with execution permission can run the saved configuration."
              : "Only the creator and invited members with execution permission can run this workflow."}{" "}
            Reports keep their own access settings. Manage invitations through{" "}
            <Link to="/contexts/$id" params={{ id }} className="text-primary underline">
              Context access
            </Link>
            .
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
