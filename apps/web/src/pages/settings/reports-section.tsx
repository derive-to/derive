import { useState } from "react"
import { api, type Report } from "@/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export function ReportsSection({
  reports,
  reload,
  show,
}: {
  reports: Report[]
  reload: () => void
  show: (m: string) => void
}) {
  return (
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Abuse reports against artifacts in this workspace. Take an artifact down to 410 its content
        everywhere (the record is kept), or dismiss the report.
      </p>
      <div className="flex flex-col gap-2.5">
        {reports.map((r) => (
          <ReportRow
            key={r.id}
            report={r}
            onChanged={(m) => {
              show(m)
              reload()
            }}
            onError={show}
          />
        ))}
      </div>
    </section>
  )
}

function ReportRow({
  report,
  onChanged,
  onError,
}: {
  report: Report
  onChanged: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      onChanged(msg)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      data-testid={`report-row-${report.id}`}
      className="flex gap-3 border-destructive/50 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">
          {report.reason}{" "}
          <a
            href={`/a/${report.artifact_short_id}`}
            className="font-mono text-xs font-medium text-primary"
          >
            {report.artifact_short_id}
          </a>
        </div>
        {report.detail && (
          <div className="mt-0.5 text-xs text-muted-foreground">{report.detail}</div>
        )}
        <div className="mt-1 text-2xs text-muted-foreground">
          {report.reporter ? `reported from ${report.reporter}` : "reported anonymously"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          data-testid={`report-dismiss-${report.id}`}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => act(() => api.dismissReport(report.id), "Report dismissed")}
        >
          Dismiss
        </Button>
        <Button
          data-testid={`report-takedown-${report.id}`}
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() =>
            confirm(`Take down ${report.artifact_short_id}? Its content stops serving (410).`) &&
            act(() => api.takedown(report.artifact_id), "Artifact taken down")
          }
        >
          Take down
        </Button>
      </div>
    </Card>
  )
}
