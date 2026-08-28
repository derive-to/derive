import { useQuery } from "@tanstack/react-query"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { SectionTitle } from "@/components/shared/section-title"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { useApiMutation } from "@/lib/use-api-mutation"
import { EXPORT_OPTIONS, isActiveExportJob } from "./export-options"

export function ExportJobList({ shortId, open }: { shortId: string; open: boolean }) {
  const jobs = useQuery({
    queryKey: ["exports", shortId],
    queryFn: () => api.listExports(shortId),
    enabled: open,
    refetchInterval: (query) => (query.state.data?.jobs.some(isActiveExportJob) ? 1_500 : false),
  })
  const cancel = useApiMutation<{ ok: true }, string>({
    mutationFn: (id) => api.cancelExport(id),
    invalidate: [["exports", shortId]],
    pendingKey: (id) => id,
  })

  if (jobs.isPending && open)
    return (
      <div className="text-sm text-muted-foreground" data-testid="exports-loading">
        Loading recent exports…
      </div>
    )

  if (jobs.isError)
    return (
      <StatusPanel
        tone="danger"
        layout="inline"
        title="Couldn’t load recent exports"
        action={
          <Button
            data-testid="exports-retry"
            size="sm"
            variant="outline"
            onClick={() => jobs.refetch()}
          >
            Try again
          </Button>
        }
      />
    )

  if (!jobs.data?.jobs.length) return null

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle count={jobs.data.jobs.length}>Recent exports</SectionTitle>
      <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {jobs.data.jobs.map((job) => (
          <div
            key={job.id}
            data-testid={`export-job-${job.id}`}
            className="flex items-center gap-3 rounded-lg bg-secondary px-3 py-2"
          >
            <Icon
              name={
                job.status === "ready"
                  ? "check"
                  : job.status === "dead" || job.status === "failed"
                    ? "report"
                    : "history"
              }
              className="text-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">
                {EXPORT_OPTIONS[job.kind].label} · v{job.version}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {job.status === "dead" || job.status === "failed"
                  ? (job.error ?? "Export failed")
                  : job.status}
              </div>
            </div>
            {job.download_url && job.kind !== "email" && (
              <Button data-testid={`export-download-${job.id}`} size="xs" variant="outline" asChild>
                <a href={job.download_url}>Download</a>
              </Button>
            )}
            {job.preview_url && (
              <Button data-testid={`export-preview-${job.id}`} size="xs" variant="outline" asChild>
                <a href={job.preview_url} target="_blank" rel="noreferrer">
                  Preview email
                </a>
              </Button>
            )}
            {job.public_url && (
              <Button data-testid={`export-image-${job.id}`} size="xs" variant="ghost" asChild>
                <a href={job.public_url} target="_blank" rel="noreferrer">
                  Image
                </a>
              </Button>
            )}
            {isActiveExportJob(job) && (
              <Button
                data-testid={`export-cancel-${job.id}`}
                size="xs"
                variant="ghost"
                disabled={cancel.isPendingFor(job.id)}
                onClick={() => cancel.mutate(job.id)}
              >
                Cancel
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
