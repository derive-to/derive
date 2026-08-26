import { useQuery } from "@tanstack/react-query"
import { api, type WorkflowRunSummary } from "@/api"
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

export function WorkflowRunHistory({ shortId, diagramId }: { shortId: string; diagramId: string }) {
  const query = useQuery({
    queryKey: ["workflow-runs", shortId, diagramId] as const,
    queryFn: () => api.workflowRuns(shortId, diagramId),
    refetchInterval: (current) =>
      current.state.data?.runs.some((run) => !terminal.has(run.status)) ? 5000 : false,
  })

  if (query.isPending) {
    return (
      <div className="border-t border-border-soft px-4 py-3 text-xs text-muted-foreground sm:px-5">
        Checking recent runs…
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="border-t border-border-soft px-4 py-3 text-xs text-destructive sm:px-5">
        Couldn’t load recent runs.
      </div>
    )
  }
  if (query.data.runs.length === 0) {
    return (
      <div className="border-t border-border-soft px-4 py-3 text-xs text-muted-foreground sm:px-5">
        No runs yet. Starting this workflow creates a separate, version-pinned run.
      </div>
    )
  }

  return (
    <section className="border-t border-border-soft px-4 py-3 sm:px-5" data-testid="workflow-runs">
      <div className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
        Recent runs
      </div>
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
            {index === 0 ? (
              <div className="mt-2 grid gap-2">
                <p className="text-xs text-muted-foreground">{runDetail(run)}</p>
                {run.attempts.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {run.attempts.map((attempt) => (
                      <span
                        key={attempt.id}
                        className="rounded-md border border-border bg-background px-2 py-1 font-mono text-2xs text-muted-foreground"
                      >
                        {attempt.nodeId} · {statusLabel(attempt.status)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
