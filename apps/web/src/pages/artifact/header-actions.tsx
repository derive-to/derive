import { useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { Textarea } from "@/components/ui/textarea"

// Favorite is the one property kept VISIBLE in the header — the filled star is a
// glanceable state (you see at a glance that this artifact is starred), and a
// sanctioned ink moment. Everything else (tags, collections, report) opens from the
// ⋯ menu as a dialog; the tags/collections dialogs live in
// components/shared/organize-dialogs (shared with the library's quick actions).
export function StarButton({
  shortId,
  favorite,
  onChange,
}: {
  shortId: string
  favorite: boolean
  onChange: (f: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    const next = !favorite
    onChange(next)
    setBusy(true)
    try {
      await api.favorite(shortId, next)
    } catch {
      onChange(!next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      disabled={busy}
      // Icon-only chrome carries its label via aria-label + aria-pressed, not a
      // `title` (invisible to keyboard + touch) — the house chrome pattern.
      aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={favorite}
      data-testid="artifact-star"
    >
      <Icon
        name="star"
        size={16}
        weight={favorite ? "fill" : "regular"}
        className={favorite ? "text-primary" : "text-muted-foreground"}
      />
    </Button>
  )
}

// Report dialog: anyone viewing can flag an artifact for moderation. Opened from
// the ⋯ menu (a rare action). A short reason is required; owners triage the queue
// in Settings.
export function ReportDialog({
  shortId,
  open,
  onOpenChange,
}: {
  shortId: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [reason, setReason] = useState("")
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const r = reason.trim()
    if (!r || busy) return
    setBusy(true)
    try {
      await api.report(shortId, r)
      setSent(true)
      toast.success("Reported — thanks for flagging this")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report artifact</DialogTitle>
          <DialogDescription>
            Flag this for moderation. Owners triage reports in Settings.
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="text-sm leading-relaxed text-muted-foreground">
            Thanks — this has been flagged for review.
          </div>
        ) : (
          <>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What's wrong with this? (required)"
              rows={3}
              data-testid="report-reason"
              className="resize-none"
            />
            <div className="flex justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                data-testid="report-cancel"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={submit}
                loading={busy}
                disabled={!reason.trim()}
                data-testid="report-submit"
              >
                {busy ? "Sending…" : "Report"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
