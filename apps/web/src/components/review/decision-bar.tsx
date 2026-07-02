import type { Proposal } from "@/api"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

// The bottom decision bar. Request-changes / Approve open an inline note composer
// first (confirm step); approve on a stale base is spelled out as "Approve anyway".
export function ReviewDecisionBar({
  active,
  isOpen,
  isAuthor,
  canApprove,
  stale,
  currentVersion,
  narrow,
  busy,
  err,
  noteFor,
  note,
  onNoteChange,
  onOpenChanges,
  onOpenApprove,
  onCancel,
  onWithdraw,
  onSubmitChanges,
  onConfirmApprove,
}: {
  active: Proposal | null
  isOpen: boolean
  isAuthor: boolean
  canApprove: boolean
  stale: boolean
  currentVersion: number
  narrow: boolean
  busy: boolean
  err: string | null
  noteFor: "changes" | "approve" | null
  note: string
  onNoteChange: (v: string) => void
  onOpenChanges: () => void
  onOpenApprove: () => void
  onCancel: () => void
  onWithdraw: () => void
  onSubmitChanges: () => void
  onConfirmApprove: () => void
}) {
  return (
    <div className="border-t border-border bg-card">
      {noteFor && (
        <div className="px-4 pt-2.5">
          {noteFor === "approve" && (
            <div className="mb-2 text-xs leading-relaxed">
              {stale ? (
                <span className="text-warning">
                  <b className="font-medium">Heads up:</b> this was proposed against v
                  {active?.base_version}, but the live version is now v{currentVersion}. Approving
                  replaces v{currentVersion} entirely. Approve anyway?
                </span>
              ) : (
                <span className="text-muted-foreground">
                  This publishes the proposed version as the new live v{currentVersion + 1}.
                  Approve?
                </span>
              )}
            </div>
          )}
          <Textarea
            data-testid="review-note"
            aria-label="Decision note to the proposer"
            autoFocus
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={
              noteFor === "changes"
                ? "What should change? This goes back to the proposer."
                : "Optional note to the proposer (e.g. why you approved)"
            }
            className="min-h-14 resize-y"
          />
        </div>
      )}
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        {err ? (
          <span data-testid="review-error" className="text-xs text-destructive">
            {err}
          </span>
        ) : (
          isOpen &&
          canApprove &&
          !narrow &&
          !noteFor && (
            <span className="text-xs text-muted-foreground">
              Approving publishes this as the new live version.
            </span>
          )
        )}
        <span className="flex-1" />

        {noteFor ? (
          <>
            <Button
              data-testid="review-cancel"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </Button>
            {noteFor === "changes" ? (
              // Request changes is warning-toned (soft tint) — never a filled amber.
              <Button
                data-testid="review-send-request"
                variant="ghost"
                size="sm"
                className="bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning"
                disabled={busy || !note.trim()}
                onClick={onSubmitChanges}
              >
                {busy ? "Sending…" : "Send request"}
              </Button>
            ) : (
              // Approve is success-toned (soft tint) — never a filled amber.
              <Button
                data-testid="review-approve-confirm"
                variant="ghost"
                size="sm"
                className="bg-success/10 text-success hover:bg-success/15 hover:text-success"
                disabled={busy}
                onClick={onConfirmApprove}
              >
                {busy ? "Approving…" : stale ? "Approve anyway" : "Approve & publish"}
              </Button>
            )}
          </>
        ) : (
          isOpen &&
          active && (
            <>
              {isAuthor && (
                <Button
                  data-testid="review-withdraw"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onWithdraw}
                >
                  Withdraw
                </Button>
              )}
              {canApprove ? (
                <>
                  <Button
                    data-testid="review-request-changes"
                    variant="ghost"
                    size="sm"
                    className="bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning"
                    disabled={busy}
                    onClick={onOpenChanges}
                  >
                    Request changes
                  </Button>
                  <Button
                    data-testid="review-approve"
                    variant="ghost"
                    size="sm"
                    className="bg-success/10 text-success hover:bg-success/15 hover:text-success"
                    disabled={busy}
                    onClick={onOpenApprove}
                  >
                    Approve &amp; publish
                  </Button>
                </>
              ) : (
                !isAuthor && (
                  <span className="text-xs text-muted-foreground">Only an editor can approve.</span>
                )
              )}
            </>
          )
        )}
      </div>
    </div>
  )
}
