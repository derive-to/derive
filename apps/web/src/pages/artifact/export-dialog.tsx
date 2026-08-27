import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type ExportJob, type ExportKind } from "@/api"
import { Icon } from "@/components/icons"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useApiMutation } from "@/lib/use-api-mutation"

const LABELS: Record<ExportKind, string> = {
  page_pdf: "Page PDF",
  chart_png: "Chart image (PNG)",
  chart_json: "Declared data (JSON)",
  chart_csv: "Declared table (CSV)",
  email: "Send as email",
  deck_pdf: "Slide deck (PDF)",
  deck_pptx: "Slide deck (PPTX)",
}

const active = (job: ExportJob) =>
  job.status === "pending" || job.status === "rendering" || job.status === "failed"

export function ExportButton({
  shortId,
  version,
  isDeck,
}: {
  shortId: string
  version: number
  isDeck: boolean
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<ExportKind>(isDeck ? "deck_pdf" : "page_pdf")
  const [recipient, setRecipient] = useState("")
  const [note, setNote] = useState("")
  const [slot, setSlot] = useState("")
  const [publicImage, setPublicImage] = useState(false)
  const [attachPdf, setAttachPdf] = useState(false)
  const jobs = useQuery({
    queryKey: ["exports", shortId],
    queryFn: () => api.listExports(shortId),
    enabled: open,
    refetchInterval: (query) => (query.state.data?.jobs.some(active) ? 1_500 : false),
  })
  const choices: ExportKind[] = isDeck
    ? ["deck_pdf", "deck_pptx", "page_pdf", "email"]
    : ["page_pdf", "chart_png", "chart_json", "chart_csv", "email"]

  type CreateInput = Parameters<typeof api.createExport>[1]
  const create = useApiMutation<ExportJob, CreateInput>({
    mutationFn: (input) => api.createExport(shortId, input),
    invalidate: [["exports", shortId]],
    success: (_, input) => (input.kind === "email" ? "Email is preparing" : "Export is preparing"),
  })
  const cancel = useApiMutation<{ ok: true }, string>({
    mutationFn: (id) => api.cancelExport(id),
    invalidate: [["exports", shortId]],
    pendingKey: (id) => id,
  })

  const start = () =>
    create.mutate({
      kind,
      version,
      ...(slot.trim() ? { dataSlot: slot.trim() } : {}),
      ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(kind === "chart_png" || kind === "email" ? { publicImage } : {}),
      ...(kind === "email" ? { attachPdf } : {}),
    })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="share-export-trigger" variant="outline" size="sm">
          <Icon name="copy" /> Export &amp; email
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Export version {version}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="export-kind">
              Output
            </label>
            <Select value={kind} onValueChange={(value) => setKind(value as ExportKind)}>
              <SelectTrigger id="export-kind" className="w-full" data-testid="export-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {LABELS[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(kind === "chart_json" || kind === "chart_csv") && (
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor="export-data-slot">
                Declared data slot
              </label>
              <Input
                id="export-data-slot"
                data-testid="export-data-slot"
                value={slot}
                onChange={(e) => setSlot(e.target.value)}
                placeholder="revenue-by-month"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Data comes from this version's declared Derive fact. Pixels are never scraped.
              </p>
            </div>
          )}

          {kind === "email" && (
            <>
              <div>
                <label className="mb-1.5 block text-sm font-medium" htmlFor="export-recipient">
                  Recipient
                </label>
                <Input
                  id="export-recipient"
                  type="email"
                  data-testid="export-recipient"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="person@example.com"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium" htmlFor="export-note">
                  Message
                </label>
                <Textarea
                  id="export-note"
                  data-testid="export-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="A short note that travels with this static copy."
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border-soft p-3">
                <div>
                  <div className="text-sm font-medium">Host the image publicly</div>
                  <div className="text-xs text-muted-foreground">
                    Off uses a private inline CID image. On creates an immutable capability URL.
                  </div>
                </div>
                <Switch
                  checked={publicImage}
                  onCheckedChange={setPublicImage}
                  aria-label="Host email image publicly"
                  data-testid="export-public-image"
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border-soft p-3">
                <div>
                  <div className="text-sm font-medium">Attach PDF</div>
                  <div className="text-xs text-muted-foreground">
                    Adds a pinned PDF of the same version.
                  </div>
                </div>
                <Switch
                  checked={attachPdf}
                  onCheckedChange={setAttachPdf}
                  aria-label="Attach PDF"
                  data-testid="export-attach-pdf"
                />
              </div>
            </>
          )}

          {(kind === "chart_png" || kind === "email") && (
            <p className="text-xs text-muted-foreground">
              Charts settle with motion disabled, fonts and images ready, and a bounded export-ready
              fallback.
            </p>
          )}

          <Button
            data-testid="export-create"
            onClick={start}
            disabled={
              create.isPending ||
              (kind === "email" && !recipient.trim()) ||
              ((kind === "chart_json" || kind === "chart_csv") && !slot.trim())
            }
          >
            {create.isPending ? "Starting…" : kind === "email" ? "Prepare & send" : "Create export"}
          </Button>

          {jobs.isPending && open && (
            <div className="text-sm text-muted-foreground" data-testid="exports-loading">
              Loading recent exports…
            </div>
          )}
          {jobs.isError && (
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
          )}
          {!!jobs.data?.jobs.length && (
            <div className="border-t border-border pt-4">
              <div className="mb-2 text-sm font-medium">Recent exports</div>
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
                        {LABELS[job.kind]} · v{job.version}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {job.status === "dead" || job.status === "failed"
                          ? (job.error ?? "Export failed")
                          : job.status}
                      </div>
                    </div>
                    {job.download_url && job.kind !== "email" && (
                      <Button
                        data-testid={`export-download-${job.id}`}
                        size="xs"
                        variant="outline"
                        asChild
                      >
                        <a href={job.download_url}>Download</a>
                      </Button>
                    )}
                    {job.preview_url && (
                      <Button
                        data-testid={`export-preview-${job.id}`}
                        size="xs"
                        variant="outline"
                        asChild
                      >
                        <a href={job.preview_url} target="_blank" rel="noreferrer">
                          Preview email
                        </a>
                      </Button>
                    )}
                    {job.public_url && (
                      <Button
                        data-testid={`export-image-${job.id}`}
                        size="xs"
                        variant="ghost"
                        asChild
                      >
                        <a href={job.public_url} target="_blank" rel="noreferrer">
                          Image
                        </a>
                      </Button>
                    )}
                    {active(job) && (
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
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
