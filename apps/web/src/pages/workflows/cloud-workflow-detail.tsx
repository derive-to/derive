import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { ApiError } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { contextQuery, contextRuntimeQuery, workflowConfigurationQuery } from "@/lib/queries"
import { ManagedRuntimeCard } from "../context/managed-runtime-card"
import { RuntimeAccessCard } from "../context/runtime-access-card"

export function CloudWorkflowDetail({ id }: { id: string }) {
  const context = useQuery(contextQuery(id))
  const configuration = useQuery(workflowConfigurationQuery(id))
  const runtime = useQuery({ ...contextRuntimeQuery(id), refetchInterval: 5000 })
  const search = useSearch({ from: "/workflows" })
  const navigate = useNavigate({ from: "/workflows" })
  const cannotReadRuns = runtime.error instanceof ApiError && runtime.error.status === 403
  if (context.isError || configuration.isError || (runtime.isError && !cannotReadRuns))
    return (
      <LoadError
        title="Couldn’t open this workflow"
        description="It may be unavailable, or you may not have permission to run it."
        testId="workflow-detail-retry"
        onRetry={() => {
          void context.refetch()
          void runtime.refetch()
          void configuration.refetch()
        }}
      />
    )
  if (!context.data || !configuration.data || (!runtime.data && !cannotReadRuns))
    return <Skeleton className="h-48 rounded-xl" />
  if (runtime.data?.enabled && !runtime.data.managed)
    return (
      <p className="text-sm text-muted-foreground">
        Cloud execution is not available for this workflow in this workspace.
      </p>
    )
  const state = {
    ...(runtime.data ?? {
      enabled: false,
      runtime: null,
      schedule: null,
      next_run_at: null,
      runs: [],
    }),
    can_edit: configuration.data.readiness.can_edit,
  }
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
          <ManagedRuntimeCard contextId={id} state={state} view="runs" />
        </TabsContent>
        <TabsContent value="configuration" className="flex flex-col gap-5 pt-5">
          <ManagedRuntimeCard
            contextId={id}
            state={state}
            view="configuration"
            access={state.can_edit && <RuntimeAccessCard context={context.data} />}
          />
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
