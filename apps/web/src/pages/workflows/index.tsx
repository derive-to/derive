import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { WorkflowDirectoryItem } from "@/api"
import { Icon } from "@/components/icons"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SectionHeading } from "@/components/shared/section-title"
import { StatusBadge } from "@/components/shared/status-badge"
import { Skeleton } from "@/components/ui/skeleton"
import { workflowsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useDocumentTitle } from "@/lib/use-document-title"
import { SettingsListSkeleton } from "../settings/settings-list-skeleton"
import { AutomatedWorkflows } from "./automated-workflows"

const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`

const workflowMeta = (workflow: WorkflowDirectoryItem): string => {
  const counts = workflow.diagrams.reduce(
    (total, diagram) => ({
      agentSteps: total.agentSteps + diagram.agentSteps,
      humanPauses: total.humanPauses + diagram.humanPauses,
      branches: total.branches + diagram.branches,
      loops: total.loops + diagram.loops,
    }),
    { agentSteps: 0, humanPauses: 0, branches: 0, loops: 0 },
  )
  return [
    countLabel(counts.agentSteps, "Context step"),
    counts.humanPauses ? countLabel(counts.humanPauses, "human pause") : "No human pauses",
    counts.loops
      ? countLabel(counts.loops, "bounded loop")
      : counts.branches
        ? countLabel(counts.branches, "possible branch", "possible branches")
        : "Linear",
    `v${workflow.version}`,
    ago(workflow.updatedAt),
  ].join(" · ")
}

export function Workflows() {
  useDocumentTitle("Workflows")
  const { data, isPending, isError, refetch } = useQuery(workflowsQuery())

  return (
    <PageShell className="flex flex-col gap-10">
      <PageHeader
        title="Workflows"
        subtitle={
          <>
            Reusable work. A workflow may coordinate several steps or give one Agent a standing
            instruction. Every start creates a fresh run.
          </>
        }
      />

      <section className="flex flex-col gap-4" data-testid="workflow-directory">
        <div className="flex flex-col gap-1">
          <SectionHeading>Coordinated workflows</SectionHeading>
          <p className="text-sm text-muted-foreground">
            Versioned graphs and loops made from Context steps, branches, and human pauses.
          </p>
        </div>
        {isPending ? (
          <SettingsListSkeleton rows={3} trailing={false} />
        ) : isError ? (
          <LoadError
            title="Couldn’t load workflows"
            testId="workflows-retry"
            layout="inline"
            onRetry={() => refetch()}
          />
        ) : !data?.length ? (
          <p className="py-3.5 text-sm text-muted-foreground">
            No coordinated workflows yet. They appear here when an Artifact carries a workflow
            definition.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border-soft">
            {data.map((workflow) => (
              <Link
                key={workflow.shortId}
                to="/artifacts/$ref"
                params={{ ref: workflow.shortId }}
                data-testid="workflow-row"
                className="rounded-md px-2 transition-colors hover:bg-accent"
              >
                <ListRow
                  leading={
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent">
                      <Icon name="workflow" className="text-muted-foreground" />
                    </span>
                  }
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{workflow.title}</span>
                      {workflow.status === "needs-changes" ? (
                        <StatusBadge tone="attention">Needs changes</StatusBadge>
                      ) : null}
                    </span>
                  }
                  meta={workflow.purpose ?? workflowMeta(workflow)}
                  below={
                    workflow.purpose ? (
                      <p className="pl-10 font-mono text-2xs text-muted-foreground">
                        {workflowMeta(workflow)}
                      </p>
                    ) : undefined
                  }
                />
              </Link>
            ))}
          </div>
        )}
      </section>

      <AutomatedWorkflows />
    </PageShell>
  )
}

export function WorkflowsPending() {
  return (
    <PageShell className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </header>
      {["coordinated", "single-agent"].map((section) => (
        <section key={section} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
          <SettingsListSkeleton rows={3} />
        </section>
      ))}
    </PageShell>
  )
}
