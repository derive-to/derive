import { useState } from "react"
import { api, type Report } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { SettingsSection } from "./settings-section"

export function ReportsSection({ reports, reload }: { reports: Report[]; reload: () => void }) {
  return (
    <SettingsSection
      title="Reports"
      description="Abuse reports against artifacts in this workspace. Take an artifact down to 410 its content everywhere (the record is kept), or dismiss the report."
    >
      <SettingsGroup>
        {reports.map((r) => (
          <ReportRow
            key={r.id}
            report={r}
            onChanged={(m) => {
              toast.success(m)
              reload()
            }}
            onError={(m) => toast.error(m)}
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
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
  const [confirming, setConfirming] = useState(false)
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
    <div data-testid={`report-row-${report.id}`} className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">
          {report.reason}{" "}
          <a
            href={`/a/${report.artifact_short_id}`}
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
          disabled={busy}
          onClick={() => act(() => api.dismissReport(report.id), "Report dismissed")}
        >
          Dismiss
        </Button>
        <Button
          data-testid={`report-takedown-${report.id}`}
          variant="destructive-ghost"
          size="sm"
          disabled={busy}
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
        onConfirm={() => act(() => api.takedown(report.artifact_id), "Artifact taken down")}
      />
    </div>
  )
}
