import { useState } from "react"
import { api, type ExportJob, type ExportKind } from "@/api"
import { Icon } from "@/components/icons"
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
import { ExportJobList } from "./export-job-list"
import { EXPORT_OPTIONS, exportChoices } from "./export-options"

/** Fast client-side feedback only; the API remains authoritative. This mirrors the
 * browser's email input shape while keeping the dialog's button from bypassing
 * native validation through a plain onClick handler. */
export const isValidExportRecipient = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

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
  const [emailMode, setEmailMode] = useState<"auto" | "snapshot">("auto")
  const recipientInvalid = !!recipient.trim() && !isValidExportRecipient(recipient)
  const option = EXPORT_OPTIONS[kind]
  const choices = exportChoices(isDeck)

  type CreateInput = Parameters<typeof api.createExport>[1]
  const create = useApiMutation<ExportJob, CreateInput>({
    mutationFn: (input) => api.createExport(shortId, input),
    invalidate: [["exports", shortId]],
    success: (_, input) => (input.kind === "email" ? "Email is preparing" : "Export is preparing"),
  })
  const start = () =>
    create.mutate({
      kind,
      version,
      ...(slot.trim() ? { dataSlot: slot.trim() } : {}),
      ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(option.supportsPublicImage ? { publicImage } : {}),
      ...(option.email ? { attachPdf, emailMode } : {}),
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
                    {EXPORT_OPTIONS[choice].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {option.requiresDataSlot && (
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

          {option.email && (
            <>
              <div>
                <label className="mb-1.5 block text-sm font-medium" htmlFor="export-recipient">
                  Recipient
                </label>
                <Input
                  id="export-recipient"
                  type="email"
                  data-testid="export-recipient"
                  aria-invalid={recipientInvalid}
                  aria-describedby={recipientInvalid ? "export-recipient-error" : undefined}
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="person@example.com"
                />
                {recipientInvalid && (
                  <p
                    id="export-recipient-error"
                    className="mt-1 text-xs text-destructive"
                    data-testid="export-recipient-error"
                  >
                    Enter a valid email address.
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium" htmlFor="export-email-mode">
                  Email body
                </label>
                <Select
                  value={emailMode}
                  onValueChange={(value) => setEmailMode(value as "auto" | "snapshot")}
                >
                  <SelectTrigger
                    id="export-email-mode"
                    className="w-full"
                    data-testid="export-email-mode"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Rich HTML when declared (recommended)</SelectItem>
                    <SelectItem value="snapshot">Artifact snapshot</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Uses the version&apos;s email-layout fact for email-safe text and charts, with a
                  snapshot fallback.
                </p>
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

          {option.supportsPublicImage && (
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
              (option.email && (!recipient.trim() || recipientInvalid)) ||
              (option.requiresDataSlot && !slot.trim())
            }
          >
            {create.isPending ? "Starting…" : option.email ? "Prepare & send" : "Create export"}
          </Button>
          <ExportJobList shortId={shortId} open={open} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
