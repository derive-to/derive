import type { RunAttemptPhase } from "@derive/core"
import type { api } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { StatusBadge } from "@/components/shared/status-badge"
import { runtimeReport } from "@/lib/runtime-report"

type RuntimeRun = Awaited<ReturnType<typeof api.getContextRuntime>>["runs"][number]
const phases: Record<RunAttemptPhase, string> = {
  starting: "Starting workspace",
  ready: "Workspace ready",
  launching: "Starting agent",
  running: "Agent running",
  stopping: "Saving files and stopping",
  released: "Workspace stopped",
}
export function RuntimeRunHistory({ runs }: { runs: RuntimeRun[] }) {
  if (!runs.length)
    return (
      <EmptyState
        title="No runs yet"
        description="Configure the workflow and run it. Progress and reports will appear here."
      />
    )
  return (
    <div className="flex flex-col gap-3">
      {runs.map((item) => {
        const report = runtimeReport(item.meta)
        let summary: string | null = null
        try {
          summary = JSON.parse(item.attempt?.result_json ?? "null")?.summary ?? null
        } catch {
          /* A malformed receipt must not hide the history. */
        }
        return (
          <article
            key={item.id}
            className="flex flex-col gap-3 rounded-xl border bg-card p-4"
            data-testid={`cloud-run-${item.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <time className="text-xs text-muted-foreground" dateTime={item.created_at}>
                {new Date(item.created_at).toLocaleString()}
              </time>
              <StatusBadge
                tone={
                  item.status === "succeeded"
                    ? "ok"
                    : item.status === "failed"
                      ? "error"
                      : item.status === "running"
                        ? "busy"
                        : "muted"
                }
              >
                {item.status === "succeeded"
                  ? "Completed"
                  : item.status === "running"
                    ? "Running"
                    : item.status === "failed"
                      ? "Failed"
                      : "Queued"}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground">
              {item.reason === "schedule" ? "Scheduled run" : "Manual run"}
              {item.attempt
                ? ` · ${phases[item.attempt.phase]}`
                : item.status === "failed"
                  ? " · Did not start"
                  : " · Waiting to start"}
              {item.attempt?.save_status === "saved"
                ? " · Files saved"
                : item.attempt?.save_status === "failed"
                  ? " · File saving failed"
                  : ""}
            </p>
            {item.status === "failed" && !item.attempt && (
              <p className="text-sm text-muted-foreground">
                This run could not start. Review the workflow’s account, credentials and schedule,
                then start a new run.
              </p>
            )}
            {report?.report_short_id ? (
              <a
                data-testid={`context-runtime-report-${item.id}`}
                className="text-sm text-primary underline underline-offset-4"
                href={`/artifacts/${encodeURIComponent(report.report_short_id)}`}
              >
                Open report
              </a>
            ) : typeof summary === "string" && summary ? (
              <details>
                <summary
                  className="cursor-pointer text-sm text-primary"
                  data-testid={`context-runtime-receipt-${item.id}`}
                >
                  Read received report
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-sm">{summary}</p>
              </details>
            ) : item.status === "succeeded" ? (
              <p className="text-sm text-muted-foreground">
                Completed. No report is available to you here.
              </p>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}
