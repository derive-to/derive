import { useQuery } from "@tanstack/react-query"
import { api, type WorkflowRunSummary } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

const terminal = new Set<WorkflowRunSummary["status"]>(["succeeded", "failed", "cancelled"])

const statusTone = (status: WorkflowRunSummary["status"]): string => {
  if (status === "succeeded") return "bg-success"
  if (status === "failed" || status === "cancelled") return "bg-destructive"
  if (status === "waiting") return "bg-warning"
  if (status === "running") return "bg-insights"
  return "bg-muted-foreground"
}

const statusLabel = (status: WorkflowRunSummary["status"]): string =>
  status.charAt(0).toUpperCase() + status.slice(1)

type WorkflowAttempt = WorkflowRunSummary["attempts"][number]

const attemptKindLabel = (kind: WorkflowAttempt["kind"]): string => {
  if (kind === "context") return "Agent"
  if (kind === "human") return "Human pause"
  return "Terminal"
}

export const workflowAttemptRoute = (attempt: WorkflowAttempt): string | null => {
  if (attempt.selectedRoutes === null) return null
  if (attempt.selectedRoutes.length > 0) return `Next: ${attempt.selectedRoutes.join(", ")}`
  if (attempt.status === "succeeded" && attempt.finishedAt) return "No next node selected"
  return null
}

const deliveryLabel = (run: WorkflowRunSummary): string => {
  if (run.actualExecution) return run.actualExecution
  if (run.reason === "agent-request") return "assigned agent"
  if (run.reason === "manual:copy") return "local copy"
  return run.requestedExecution
}

const runDetail = (run: WorkflowRunSummary): string => {
  const waiting = run.attempts.find((attempt) => attempt.status === "waiting")
  if (waiting) return `${waiting.nodeId} is waiting.`
  const active = run.attempts.find((attempt) => attempt.status === "running")
  if (active) return `${active.nodeId} is running.`
  if (run.status === "queued") return "Waiting for an agent to claim this run."
  if (run.status === "running" && run.attempts.length === 0)
    return "The agent claimed this run; no step receipt has arrived yet."
  if (run.status === "succeeded") return "The workflow finished successfully."
  if (run.status === "failed") return "The workflow stopped after a failure."
  if (run.status === "cancelled") return "The workflow was cancelled."
  return `${run.attempts.length} materialized attempt${run.attempts.length === 1 ? "" : "s"}.`
}

const WorkflowAttemptTimeline = ({ attempts }: { attempts: WorkflowAttempt[] }) => (
  <ol className="grid gap-2" aria-label="Materialized workflow steps">
    {attempts.map((attempt) => {
      const route = workflowAttemptRoute(attempt)
      return (
        <li
          key={attempt.id}
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2.5 rounded-lg border border-border-soft bg-background px-3 py-2.5"
        >
          <span
            aria-hidden="true"
            className={cn("mt-1 size-2 rounded-full", statusTone(attempt.status))}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="break-all font-mono text-xs font-medium text-foreground">
                  {attempt.nodeId}
                </span>
                <span className="text-2xs text-muted-foreground">
                  {attemptKindLabel(attempt.kind)} · attempt {attempt.attempt}
                </span>
              </div>
              <span className="text-2xs font-medium text-muted-foreground">
                {statusLabel(attempt.status)}
              </span>
            </div>
            {route || attempt.routeBasis || attempt.resultArtifactId ? (
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                {route ? <span>{route}</span> : null}
                {attempt.routeBasis ? (
                  <span className="break-words">Because: {attempt.routeBasis}</span>
                ) : null}
                {attempt.resultArtifactId ? (
                  <a
                    className="font-medium text-primary hover:underline"
                    href={`/artifacts/${attempt.resultArtifactId}`}
                    aria-label={`Open result from ${attempt.nodeId}`}
                  >
                    Open result
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        </li>
      )
    })}
  </ol>
)

export function WorkflowRunHistory({ shortId, diagramId }: { shortId: string; diagramId: string }) {
  const query = useQuery({
    queryKey: ["workflow-runs", shortId, diagramId] as const,
    queryFn: () => api.workflowRuns(shortId, diagramId),
    refetchInterval: (current) =>
      current.state.data?.runs.some((run) => !terminal.has(run.status)) ? 5000 : false,
  })

  if (query.isPending) {
    return (
      <div className="px-4 pb-4 text-xs text-muted-foreground sm:px-5" role="status">
        Checking recent runs…
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="px-4 pb-4 text-xs text-destructive sm:px-5">Couldn’t load recent runs.</div>
    )
  }
  if (query.data.runs.length === 0) {
    return (
      <div className="px-4 pb-4 text-xs text-muted-foreground sm:px-5">
        No runs yet. Starting this workflow creates a separate, version-pinned run.
      </div>
    )
  }

  return (
    <section className="px-4 pb-4 sm:px-5" data-testid="workflow-runs">
      <Eyebrow as="div">Recent runs</Eyebrow>
      <div className="mt-2 grid gap-2">
        {query.data.runs.map((run, index) => (
          <article
            key={run.id}
            className={cn(
              "rounded-lg border border-border-soft px-3 py-2.5",
              index === 0 && "bg-muted/20",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
                <span className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))} />
                <span>{statusLabel(run.status)}</span>
                <span className="font-mono text-2xs font-normal text-muted-foreground">
                  {run.id.slice(-8)}
                </span>
              </div>
              <span className="font-mono text-2xs text-muted-foreground">
                v{run.workflowVersion} · {deliveryLabel(run)} · {ago(run.createdAt)}
              </span>
            </div>
            {run.attempts.length > 0 && index === 0 ? (
              <div className="mt-2 grid gap-2">
                <p className="text-xs text-muted-foreground">{runDetail(run)}</p>
                <WorkflowAttemptTimeline attempts={run.attempts} />
              </div>
            ) : run.attempts.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {runDetail(run)}
                </summary>
                <div className="mt-2">
                  <WorkflowAttemptTimeline attempts={run.attempts} />
                </div>
              </details>
            ) : index === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{runDetail(run)}</p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
