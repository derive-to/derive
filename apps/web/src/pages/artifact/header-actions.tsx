import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, workspaceDisplayName } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { Textarea } from "@/components/ui/textarea"
import { artifactQuery, workspacesQuery } from "@/lib/queries"

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

// Move-to-workspace dialog: owner-only (the ⋯ menu hides the trigger otherwise).
// Destination is any workspace you belong to, any role — not just ones you own.
// Opened from the ⋯ menu (controlled).
export function MoveToWorkspaceDialog({
  shortId,
  currentOrgId,
  open,
  onOpenChange,
}: {
  shortId: string
  currentOrgId: string | undefined
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const { data: workspaces } = useQuery({ ...workspacesQuery(), enabled: open })
  const [target, setTarget] = useState<string>("")
  const [busy, setBusy] = useState(false)
  // Personal renders under its display name (the one rule in workspaceDisplayName),
  // pinned first — same order as the switcher.
  const options = (workspaces?.workspaces ?? [])
    .filter((w) => w.id !== currentOrgId)
    .map((w) => ({ ...w, display: workspaceDisplayName(w) }))
    .sort((a, b) => Number(b.personal) - Number(a.personal))
  const move = async () => {
    if (!target || busy) return
    setBusy(true)
    try {
      await api.moveArtifact(shortId, target)
      await qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
      const name = options.find((w) => w.id === target)?.display ?? "the workspace"
      toast.success(`Moved to ${name}`)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't move this artifact")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to workspace</DialogTitle>
          <DialogDescription>
            Moves this artifact into another workspace you belong to. Comments, versions, and
            history come with it; it leaves any collections here.
          </DialogDescription>
        </DialogHeader>
        {options.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            You're not a member of any other workspace yet.
          </div>
        ) : (
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-full" data-testid="move-workspace-select">
              <SelectValue placeholder="Select a workspace" />
            </SelectTrigger>
            <SelectContent>
              {options.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.display}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {options.length > 0 && (
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="move-workspace-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={move}
              loading={busy}
              disabled={!target}
              data-testid="move-workspace-submit"
            >
              {busy ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
