import { useQuery } from "@tanstack/react-query"
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
import { Textarea } from "@/components/ui/textarea"
import { artifactQuery, workspacesQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

// Favorite is the one property kept VISIBLE in the header — the filled star is a
// glanceable state (you see at a glance that this artifact is starred), and a
// sanctioned ink moment. Everything else (collections, report) opens from the
// ⋯ menu as a dialog; the collections dialog lives in
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
  const star = useApiMutation({
    mutationFn: (next: boolean) => api.favorite(shortId, next),
    optimistic: (next) => {
      onChange(next)
      return () => onChange(!next)
    },
  })
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => star.mutate(!favorite)}
      disabled={star.isPending}
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
  const report = useApiMutation({
    mutationFn: () => api.report(shortId, reason.trim()),
    success: "Report sent. Thanks for flagging this.",
    onSuccess: () => setSent(true),
  })
  const submit = () => {
    if (reason.trim()) report.mutate()
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
            Thanks. This has been flagged for review.
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
                loading={report.isPending}
                disabled={!reason.trim()}
                data-testid="report-submit"
              >
                {report.isPending ? "Sending…" : "Report"}
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
  const { data: workspaces } = useQuery({ ...workspacesQuery(), enabled: open })
  const [target, setTarget] = useState<string>("")
  // Personal renders under its display name (the one rule in workspaceDisplayName),
  // pinned first — same order as the switcher.
  const options = (workspaces?.workspaces ?? [])
    .filter((w) => w.id !== currentOrgId)
    .map((w) => ({ ...w, display: workspaceDisplayName(w) }))
    .sort((a, b) => Number(b.personal) - Number(a.personal))
  const move = useApiMutation({
    mutationFn: () => api.moveArtifact(shortId, target),
    success: () => `Moved to ${options.find((w) => w.id === target)?.display ?? "the workspace"}`,
    invalidate: [artifactQuery(shortId).queryKey],
    onSuccess: () => onOpenChange(false),
  })
  const doMove = () => {
    if (target) move.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to workspace</DialogTitle>
          <DialogDescription>
            Moves this artifact and any same-workspace linked bundle members into another workspace
            you belong to. Comments, versions, and history come with them; they leave any
            collections here.
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
              onClick={doMove}
              loading={move.isPending}
              disabled={!target}
              data-testid="move-workspace-submit"
            >
              {move.isPending ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
