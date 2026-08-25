import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { api, type ContextInfo } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { contextsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { ContextRow } from "@/pages/context"
import { ContextRowsSkeleton } from "@/pages/context/context-skeleton"

export const WORKFLOW_VIEWS = ["all", "contexts", "graphs", "loops"] as const
export type WorkflowView = (typeof WORKFLOW_VIEWS)[number]
export type WorkflowsSearch = { view?: WorkflowView }

const kindForView = (view: Exclude<WorkflowView, "all">): ContextInfo["kind"] =>
  view === "contexts" ? "single" : view === "graphs" ? "graph" : "loop"

export const workflowContextsForView = (
  contexts: ContextInfo[],
  view: WorkflowView,
): ContextInfo[] => {
  const filtered = view === "all" ? contexts : contexts.filter((x) => x.kind === kindForView(view))
  return [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function WorkflowsPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-8 w-72 rounded-lg" />
      <ContextRowsSkeleton />
    </PageShell>
  )
}

function ImportWorkflowsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const plan = useQuery({
    queryKey: ["workflow-import-plan"],
    queryFn: () => api.importWorkflows(true),
    enabled: open,
    staleTime: 0,
  })
  const mutation = useApiMutation({
    mutationFn: () => api.importWorkflows(false),
    invalidate: [contextsQuery().queryKey, ["workflow-import-plan"]],
    success: (result) =>
      result.imported
        ? `Moved ${result.imported} ${result.imported === 1 ? "workflow" : "workflows"}`
        : "Everything is already in Workflows",
    onSuccess: () => onOpenChange(false),
  })
  const importable = plan.data?.items.filter((item) => item.status === "would-import") ?? []
  const already = plan.data?.items.filter((item) => item.status === "already-imported").length ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="workflow-import-dialog">
        <DialogHeader>
          <DialogTitle>Move graphs and loops into Workflows</DialogTitle>
          <DialogDescription>
            This creates context addresses for existing graph and loop artifacts. Their original
            URLs and version history stay unchanged.
          </DialogDescription>
        </DialogHeader>

        {plan.isPending ? (
          <div
            className="flex flex-col gap-2"
            role="status"
            aria-label="Checking existing workflows"
          >
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : plan.isError ? (
          <LoadError
            title="Couldn’t check existing workflows"
            testId="workflow-import-retry"
            onRetry={() => void plan.refetch()}
          />
        ) : importable.length ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {importable.length} {importable.length === 1 ? "item is" : "items are"} ready to move.
              Invalid definitions move too and keep their exact “needs changes” blockers.
            </p>
            <ul className="max-h-72 overflow-y-auto rounded-xl border">
              {importable.slice(0, 12).map((item) => (
                <li
                  key={`${item.manifest_short_id}:${item.diagram_id ?? "root"}`}
                  className="flex min-w-0 items-start gap-3 border-b px-3 py-2.5 last:border-b-0"
                >
                  <Icon name={item.kind} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block font-mono text-2xs text-muted-foreground">
                      {item.kind} · {item.manifest_short_id}@v{item.manifest_version}
                    </span>
                    {item.errors.length > 0 && (
                      <span className="mt-1 block line-clamp-2 text-xs text-warning">
                        Needs changes · {item.errors[0]}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {importable.length > 12 && (
              <p className="font-mono text-2xs text-muted-foreground">
                And {importable.length - 12} more.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border bg-muted/30 p-4">
            <p className="text-sm font-medium">Everything already lives here.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {already
                ? `${already} existing ${already === 1 ? "workflow is" : "workflows are"} already context-backed.`
                : "No graph or loop artifacts need to be moved."}
            </p>
          </div>
        )}

        <DialogFooter showCloseButton>
          <Button
            data-testid="workflow-import-confirm"
            onClick={() => mutation.mutate()}
            disabled={plan.isPending || plan.isError || !importable.length || mutation.isPending}
          >
            {mutation.isPending ? "Moving…" : `Move ${importable.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Workflows() {
  useDocumentTitle("Workflows")
  const search = useSearch({ from: "/workflows/" })
  const nav = useNavigate({ from: "/workflows/" })
  const [importOpen, setImportOpen] = useState(false)
  const view = search.view ?? "all"
  const contexts = useQuery(contextsQuery())
  const all = contexts.data ?? []
  const visible = workflowContextsForView(all, view)
  const counts = {
    all: all.length,
    contexts: all.filter((x) => x.kind === "single").length,
    graphs: all.filter((x) => x.kind === "graph").length,
    loops: all.filter((x) => x.kind === "loop").length,
  }
  const setView = (next: string) =>
    void nav({ search: next === "all" ? {} : { view: next as WorkflowView } })
  const noun = view === "all" ? "workflows" : view

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Workflows"
        subtitle="Contexts, graphs, and loops—one agent-system directory. Filter when you need to narrow it."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="workflows-import"
              onClick={() => setImportOpen(true)}
            >
              <Icon name="arrow" /> Move existing
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="workflows-new-context"
              onClick={() => void nav({ to: "/contexts/new" })}
            >
              <Icon name="plus" /> New context
            </Button>
          </div>
        }
      />

      <Tabs value={view} onValueChange={setView}>
        <TabsList
          aria-label="Filter workflows by type"
          className="max-w-full justify-start overflow-x-auto"
        >
          {WORKFLOW_VIEWS.map((item) => (
            <TabsTrigger key={item} value={item} data-testid={`workflows-tab-${item}`}>
              <span className="capitalize">{item}</span>
              <span className="font-mono text-2xs text-muted-foreground">{counts[item]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div data-testid={`workflows-${view}`}>
        {contexts.isPending ? (
          <ContextRowsSkeleton />
        ) : contexts.isError ? (
          <LoadError
            title="Couldn’t load workflows"
            testId="workflows-retry"
            onRetry={() => void contexts.refetch()}
          />
        ) : visible.length ? (
          <ul className="flex flex-col gap-2">
            {visible.map((context) => (
              <li key={context.id}>
                <ContextRow context={context} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={
              <Icon name={view === "graphs" ? "graph" : view === "loops" ? "loop" : "workflow"} />
            }
            title={`No ${noun} yet`}
            description={
              view === "all"
                ? "Create a reusable context, or move existing graph and loop artifacts here."
                : `No ${noun} match this filter. Existing graph and loop artifacts can be moved here without changing their URLs.`
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  data-testid="workflows-empty-new-context"
                  onClick={() => void nav({ to: "/contexts/new" })}
                >
                  <Icon name="plus" /> New context
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="workflows-empty-import"
                  onClick={() => setImportOpen(true)}
                >
                  Move existing
                </Button>
              </div>
            }
          />
        )}
      </div>

      <ImportWorkflowsDialog open={importOpen} onOpenChange={setImportOpen} />
    </PageShell>
  )
}
