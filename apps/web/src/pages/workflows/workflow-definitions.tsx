import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { WorkflowDirectoryItem } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { workflowsQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { SettingsListSkeleton } from "../settings/settings-list-skeleton"
import { WorkflowBuilderDialog } from "./workflow-builder-dialog"
import { WorkflowDirectoryHeader, WorkflowDirectoryRow } from "./workflow-directory"
export type WorkflowFilter = "all" | WorkflowDirectoryItem["status"]

export const visibleWorkflows = (
  workflows: WorkflowDirectoryItem[],
  filter: WorkflowFilter,
): WorkflowDirectoryItem[] =>
  [...(filter === "all" ? workflows : workflows.filter((item) => item.status === filter))].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  )

export function WorkflowDefinitions() {
  const { openAssistant } = useShell()
  const { data, isPending, isError, refetch } = useQuery(workflowsQuery())
  const [filter, setFilter] = useState<WorkflowFilter>("all")
  const [builderOpen, setBuilderOpen] = useState(false)
  const all = data ?? []
  const ready = all.filter((item) => item.status === "ready").length
  const needsChanges = all.length - ready
  const visible = visibleWorkflows(all, filter)

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Reusable process definitions describe steps and approvals. Open a definition to configure
        its execution. These are separate from your saved cloud workflows.
      </p>
      <Button
        className="self-start"
        size="sm"
        variant="outline"
        data-testid="workflow-definition-new"
        onClick={() => setBuilderOpen(true)}
      >
        New definition
      </Button>
      {isPending ? (
        <div
          className="grid gap-2 sm:grid-cols-3"
          role="status"
          aria-label="Loading workflow summary"
        >
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3" data-testid="workflow-summary">
          <Summary number={all.length} label="in this workspace" tone="primary" />
          <Summary number={ready} label="valid definitions" tone="success" />
          <Summary number={needsChanges} label="need changes" tone="warning" />
        </div>
      )}

      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">Filter workflows</legend>
        {(
          [
            ["all", "All", all.length],
            ["ready", "Ready", ready],
            ["needs-changes", "Needs changes", needsChanges],
          ] as const
        ).map(([value, label, count]) => (
          <Button
            key={value}
            variant={filter === value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={filter === value}
            data-testid={`workflows-filter-${value}`}
            onClick={() => setFilter(value)}
          >
            {label}
            <span className="font-mono text-2xs text-muted-foreground">{count}</span>
          </Button>
        ))}
        <span className="ml-auto font-mono text-2xs text-muted-foreground">Updated recently</span>
      </fieldset>

      <section data-testid="workflow-directory">
        {isPending ? (
          <SettingsListSkeleton rows={4} trailing={false} />
        ) : isError ? (
          <LoadError
            title="Couldn’t load workflows"
            testId="workflows-retry"
            layout="inline"
            onRetry={() => refetch()}
          />
        ) : visible.length ? (
          <div className="overflow-hidden rounded-xl border bg-card" data-testid="workflow-list">
            <WorkflowDirectoryHeader />
            {visible.map((workflow) => (
              <WorkflowDirectoryRow key={workflow.shortId} workflow={workflow} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Icon name="workflow" />}
            title={filter === "all" ? "No workflow definitions yet" : `No ${filter} workflows`}
            description={
              filter === "all"
                ? "Describe the outcome. Derive will suggest the smallest workflow that fits."
                : "Choose another filter, or create a new workflow."
            }
            action={
              <Button
                size="sm"
                data-testid="workflows-empty-new"
                onClick={() => setBuilderOpen(true)}
              >
                <Icon name="plus" /> New definition
              </Button>
            }
          />
        )}
      </section>

      {!isPending && !isError && visible.length ? (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed bg-secondary/20 p-4 sm:flex-row sm:items-center">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-card text-muted-foreground ring-1 ring-border">
            <Icon name="sparkles" />
          </span>
          <div>
            <p className="text-sm font-medium">Not sure where to start?</p>
            <p className="text-xs text-muted-foreground">
              Describe the outcome. Derive will suggest the smallest workflow that fits.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="sm:ml-auto"
            data-testid="workflows-guided-start"
            onClick={() => setBuilderOpen(true)}
          >
            Start guided
          </Button>
        </div>
      ) : null}
      <WorkflowBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        onBuild={(prompt) => openAssistant(prompt)}
      />
    </div>
  )
}
function Summary({
  number,
  label,
  tone,
}: {
  number: number
  label: string
  tone: "primary" | "success" | "warning"
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <span
        className={cn(
          "size-2 rounded-full",
          tone === "primary" ? "bg-primary" : tone === "success" ? "bg-success" : "bg-warning",
        )}
        aria-hidden
      />
      <strong className="font-mono text-lg font-medium tabular-nums">{number}</strong>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
