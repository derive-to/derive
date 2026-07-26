import { useState } from "react"
import { api, type Report } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsSection } from "./settings-section"

export function ReportsSection({ reports, reload }: { reports: Report[]; reload: () => void }) {
  return (
    <SettingsSection
      title="Reports"
      description="Abuse reports against artifacts in this workspace. Take an artifact down to 410 its content everywhere (the record is kept), or dismiss the report."
    >
      <SettingsGroup>
        {reports.map((r) => (
          <ReportRow key={r.id} report={r} onDone={reload} />
        ))}
      </SettingsGroup>
    </SettingsSection>
  )
}

function ReportRow({ report, onDone }: { report: Report; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  // Dismiss / take down. One mutation runs whichever action fired: the primitive toasts
  // the per-action success message (and any failure, via the global safety net) and
  // reloads the list. `isPending` disables both buttons while either is in flight.
  const act = useApiMutation({
    mutationFn: ({ fn }: { fn: () => Promise<unknown>; msg: string }) => fn(),
    success: (_data, { msg }) => msg,
    onSuccess: () => onDone(),
  })
  return (
    <div data-testid={`report-row-${report.id}`} className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">
          {report.reason}{" "}
          <a
            href={`/artifacts/${report.artifact_short_id}`}
            className="font-mono text-2xs font-medium text-primary"
          >
            {report.artifact_short_id}
          </a>
        </div>
        {report.detail && (
          <div className="mt-0.5 text-sm text-pretty text-muted-foreground">{report.detail}</div>
        )}
        <div className="mt-1 font-mono text-2xs text-muted-foreground">
          {report.reporter ? `reported from ${report.reporter}` : "reported anonymously"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          data-testid={`report-dismiss-${report.id}`}
          variant="outline"
          size="sm"
          disabled={act.isPending}
          onClick={() =>
            act.mutate({ fn: () => api.dismissReport(report.id), msg: "Report dismissed" })
          }
        >
          Dismiss
        </Button>
        <Button
          data-testid={`report-takedown-${report.id}`}
          variant="destructive-ghost"
          size="sm"
          disabled={act.isPending}
          onClick={() => setConfirming(true)}
        >
          Take down
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Take down ${report.artifact_short_id}?`}
        description="Its content stops serving everywhere (410). The record is kept."
        confirmLabel="Take down"
        confirmTestId={`report-takedown-confirm-${report.id}`}
        onConfirm={() =>
          act.mutate({ fn: () => api.takedown(report.artifact_id), msg: "Artifact taken down" })
        }
      />
    </div>
  )
}
