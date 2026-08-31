import { Link } from "@tanstack/react-router"
import type { WorkflowDirectoryItem } from "@/api"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

const COL = {
  icon: "w-10 shrink-0",
  name: "min-w-0 flex-1",
  structure: "w-40 shrink-0 max-md:hidden",
  state: "w-28 shrink-0 max-sm:hidden",
  when: "w-20 shrink-0 text-right",
}

const workflowCounts = (item: WorkflowDirectoryItem) =>
  item.diagrams.reduce(
    (total, diagram) => ({
      contextSteps: total.contextSteps + diagram.contextSteps,
      humanPauses: total.humanPauses + diagram.humanPauses,
      loops: total.loops + diagram.loops,
    }),
    { contextSteps: 0, humanPauses: 0, loops: 0 },
  )

export function WorkflowDirectoryHeader() {
  return (
    <div className="flex h-8 items-center border-b bg-secondary/40 px-3 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
      <span className={COL.icon} />
      <span className={COL.name}>Name</span>
      <span className={COL.structure}>Structure</span>
      <span className={COL.state}>State</span>
      <span className={COL.when}>Updated</span>
    </div>
  )
}

export function WorkflowDirectoryRow({ workflow: item }: { workflow: WorkflowDirectoryItem }) {
  const counts = workflowCounts(item)
  const ready = item.status === "ready"
  const structure = [
    `${counts.contextSteps} ${counts.contextSteps === 1 ? "step" : "steps"}`,
    counts.humanPauses ? `${counts.humanPauses} human` : null,
    counts.loops ? `${counts.loops} ${counts.loops === 1 ? "loop" : "loops"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Link
      to="/artifacts/$ref"
      params={{ ref: item.shortId }}
      data-testid={`workflow-row-${item.shortId}`}
      className="group flex min-h-16 items-center border-b border-border-soft px-3 outline-none transition-colors last:border-b-0 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className={COL.icon}>
        <span className="grid size-8 place-items-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border-soft">
          <Icon name="workflow" />
        </span>
      </span>
      <span className={cn(COL.name, "flex flex-col gap-0.5 pr-5")}>
        <span className="truncate text-sm font-medium tracking-tight text-foreground">
          {item.title}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground">
          {item.purpose ?? "Reusable coordinated work with a versioned definition."}
        </span>
      </span>
      <span className={cn(COL.structure, "font-mono text-2xs text-muted-foreground")}>
        {structure || "No Context steps"}
      </span>
      <span className={COL.state}>
        <Badge variant={ready ? "success" : "warning"} shape="pill">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", ready ? "bg-success" : "bg-warning")}
          />
          {ready ? "Ready" : "Needs changes"}
        </Badge>
      </span>
      <span className={cn(COL.when, "font-mono text-2xs tabular-nums text-muted-foreground")}>
        {ago(item.updatedAt)}
      </span>
    </Link>
  )
}
