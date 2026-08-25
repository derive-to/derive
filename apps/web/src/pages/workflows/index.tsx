import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import type { ContextInfo, WorkflowDirectoryItem } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { contextsQuery, workflowsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { refFor } from "@/pages/artifact/parse-ref"
import { ContextRow } from "@/pages/context"
import { ContextRowsSkeleton } from "@/pages/context/context-skeleton"

export const WORKFLOW_VIEWS = ["all", "contexts", "graphs", "loops"] as const
export type WorkflowView = (typeof WORKFLOW_VIEWS)[number]
export type WorkflowsSearch = { view?: WorkflowView }

export const workflowItemsForView = (
  items: WorkflowDirectoryItem[],
  view: Exclude<WorkflowView, "all" | "contexts">,
): WorkflowDirectoryItem[] =>
  items.filter((item) => item.kinds.includes(view === "graphs" ? "graph" : "loop"))

function WorkflowRowsSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="ml-6 h-3 w-full max-w-lg" />
        </li>
      ))}
    </ul>
  )
}

type DirectoryEntry =
  | { kind: "context"; at: string; context: ContextInfo }
  | { kind: "bundle"; at: string; item: WorkflowDirectoryItem }

export const workflowDirectoryEntries = (
  contexts: ContextInfo[],
  items: WorkflowDirectoryItem[],
): DirectoryEntry[] =>
  [
    ...contexts.map((context) => ({
      kind: "context" as const,
      at: context.created_at,
      context,
    })),
    ...items.map((item) => ({ kind: "bundle" as const, at: item.updated_at, item })),
  ].sort((a, b) => b.at.localeCompare(a.at))

export function WorkflowsPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-8 w-72 rounded-lg" />
      <WorkflowRowsSkeleton />
    </PageShell>
  )
}

function KindChip({ kind }: { kind: WorkflowDirectoryItem["kinds"][number] }) {
  const label = kind === "workflow" ? "Runnable" : kind === "graph" ? "Graph" : "Loop"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-2xs",
        kind === "workflow"
          ? "border-success/20 bg-success/10 text-success"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon name={kind === "workflow" ? "workflow" : kind} size={12} />
      {label}
    </span>
  )
}

function WorkflowRow({ item }: { item: WorkflowDirectoryItem }) {
  const leadKind = item.kinds.includes("loop") ? "loop" : "graph"
  return (
    <Link
      to="/artifacts/$ref"
      params={{ ref: refFor(item) }}
      data-testid="workflow-card"
      className="group flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={leadKind} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {item.title || "Untitled workflow"}
        </span>
        <Icon
          name="chevron-right"
          size={14}
          className="ml-auto shrink-0 text-muted-foreground group-hover:text-foreground"
        />
      </div>
      <p className="line-clamp-2 pl-6 text-sm text-muted-foreground">{item.purpose}</p>
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        {item.kinds.map((kind) => (
          <KindChip key={kind} kind={kind} />
        ))}
        {item.execution === "needs-changes" && (
          <span className="rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 font-mono text-2xs text-warning">
            Needs changes
          </span>
        )}
        <span className="ml-auto font-mono text-2xs text-muted-foreground">
          {item.diagram_count} {item.diagram_count === 1 ? "diagram" : "diagrams"} ·{" "}
          {item.node_count} {item.node_count === 1 ? "node" : "nodes"} · v{item.version} ·{" "}
          {ago(item.updated_at)}
        </span>
      </div>
    </Link>
  )
}

function WorkflowList({
  items,
  isPending,
  isError,
  onRetry,
  onShowAll,
  emptyKind,
}: {
  items: WorkflowDirectoryItem[]
  isPending: boolean
  isError: boolean
  onRetry: () => void
  onShowAll: () => void
  emptyKind: "workflow" | "graph" | "loop"
}) {
  if (isPending) return <WorkflowRowsSkeleton />
  if (isError)
    return <LoadError title="Couldn’t load workflows" testId="workflows-retry" onRetry={onRetry} />
  if (!items.length) {
    const noun = emptyKind === "workflow" ? "workflows" : `${emptyKind}s`
    return (
      <EmptyState
        icon={<Icon name={emptyKind} />}
        title={`No ${noun} yet`}
        description="Ask your local Claude, Codex, or other harness to publish one into this workspace."
        action={
          emptyKind === "workflow" ? null : (
            <Button
              size="sm"
              variant="outline"
              data-testid="workflows-empty-show-all"
              onClick={onShowAll}
            >
              Show all workflows
            </Button>
          )
        }
      />
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.short_id}>
          <WorkflowRow item={item} />
        </li>
      ))}
    </ul>
  )
}

export function Workflows() {
  useDocumentTitle("Workflows")
  const search = useSearch({ from: "/workflows/" })
  const nav = useNavigate({ from: "/workflows/" })
  const view = search.view ?? "all"
  const contexts = useQuery(contextsQuery())
  const workflows = useQuery(workflowsQuery())
  const items = workflows.data?.items ?? []
  const graphs = workflowItemsForView(items, "graphs")
  const loops = workflowItemsForView(items, "loops")
  const allEntries = workflowDirectoryEntries(contexts.data ?? [], items)

  const contextList = contexts.isPending ? (
    <ContextRowsSkeleton />
  ) : contexts.isError ? (
    <LoadError
      title="Couldn’t load contexts"
      testId="contexts-retry"
      onRetry={() => void contexts.refetch()}
    />
  ) : !contexts.data?.length ? (
    <EmptyState
      icon={<Icon name="context" />}
      title="No contexts yet"
      description="Create a reusable agent setup for the work your graphs and loops call into."
      action={
        <Button
          size="sm"
          data-testid="workflows-empty-new-context"
          onClick={() => void nav({ to: "/contexts/new" })}
        >
          <Icon name="plus" /> New context
        </Button>
      }
    />
  ) : (
    <ul className="flex flex-col gap-2">
      {contexts.data.map((context) => (
        <li key={context.id}>
          <ContextRow context={context} />
        </li>
      ))}
    </ul>
  )

  const setView = (next: string) =>
    void nav({ search: next === "all" ? {} : { view: next as WorkflowView } })

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Workflows"
        subtitle="Contexts, graphs, and loops—together. Filter when you need to narrow the directory."
        actions={
          <Button
            variant="outline"
            size="sm"
            data-testid="workflows-new-context"
            onClick={() => void nav({ to: "/contexts/new" })}
          >
            <Icon name="plus" /> New context
          </Button>
        }
      />

      <Tabs value={view} onValueChange={setView}>
        <TabsList
          aria-label="Filter workflows by type"
          className="max-w-full justify-start overflow-x-auto"
        >
          <TabsTrigger value="all" data-testid="workflows-tab-all">
            All
            <span className="font-mono text-2xs text-muted-foreground">{allEntries.length}</span>
          </TabsTrigger>
          <TabsTrigger value="contexts" data-testid="workflows-tab-contexts">
            Contexts
            <span className="font-mono text-2xs text-muted-foreground">
              {contexts.data?.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="graphs" data-testid="workflows-tab-graphs">
            Graphs
            <span className="font-mono text-2xs text-muted-foreground">{graphs.length}</span>
          </TabsTrigger>
          <TabsTrigger value="loops" data-testid="workflows-tab-loops">
            Loops
            <span className="font-mono text-2xs text-muted-foreground">{loops.length}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "all" ? (
        <div className="flex flex-col gap-4" data-testid="workflows-all">
          {contexts.isError && (
            <LoadError
              title="Couldn’t load contexts"
              testId="contexts-retry"
              onRetry={() => void contexts.refetch()}
              layout="inline"
            />
          )}
          {workflows.isError && (
            <LoadError
              title="Couldn’t load graphs and loops"
              testId="workflows-retry"
              onRetry={() => void workflows.refetch()}
              layout="inline"
            />
          )}
          {allEntries.length ? (
            <ul className="flex flex-col gap-2">
              {allEntries.map((entry) => (
                <li
                  key={
                    entry.kind === "context"
                      ? `context:${entry.context.id}`
                      : `bundle:${entry.item.short_id}`
                  }
                >
                  {entry.kind === "context" ? (
                    <ContextRow context={entry.context} />
                  ) : (
                    <WorkflowRow item={entry.item} />
                  )}
                </li>
              ))}
            </ul>
          ) : contexts.isPending || workflows.isPending ? (
            <WorkflowRowsSkeleton />
          ) : !contexts.isError && !workflows.isError ? (
            <EmptyState
              icon={<Icon name="workflow" />}
              title="No workflows yet"
              description="Create a context here, or ask your local agent to publish a graph or loop into this workspace."
              action={
                <Button
                  size="sm"
                  data-testid="workflows-all-empty-new-context"
                  onClick={() => void nav({ to: "/contexts/new" })}
                >
                  <Icon name="plus" /> New context
                </Button>
              }
            />
          ) : null}
        </div>
      ) : view === "contexts" ? (
        <div data-testid="workflows-contexts">{contextList}</div>
      ) : (
        <div data-testid={`workflows-${view}`}>
          <WorkflowList
            items={view === "graphs" ? graphs : loops}
            isPending={workflows.isPending}
            isError={workflows.isError}
            onRetry={() => void workflows.refetch()}
            onShowAll={() => setView("all")}
            emptyKind={view === "graphs" ? "graph" : "loop"}
          />
        </div>
      )}

      {workflows.data?.truncated && (
        <p className="text-center font-mono text-2xs text-muted-foreground">
          Showing the 200 most recent workflow bundles.
        </p>
      )}
    </PageShell>
  )
}
