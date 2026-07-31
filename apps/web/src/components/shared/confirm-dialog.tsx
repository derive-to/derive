import { type ReactNode, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// The one destructive-confirm surface: every Remove/Delete/Take down goes
// through this dialog — never window.confirm(). The confirm button keeps the
// soft destructive fill per the button doctrine: the dialog carries the
// gravity, not a loud red fill. Closes itself when onConfirm resolves; stays
// open if it throws (the caller surfaces the error via toast).
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "destructive",
  onConfirm,
  confirmTestId = "confirm-dialog-confirm",
  contentTestId,
  confirmPhrase,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** A verb: "Delete", "Remove", "Take down". */
  confirmLabel: string
  tone?: "destructive" | "default"
  onConfirm: () => void | Promise<void>
  confirmTestId?: string
  /** data-testid for the DialogContent itself. Omit for no testid (the ordinary
   *  case — most callers identify the dialog by its confirm/cancel testids). */
  contentTestId?: string
  /** Require the user to TYPE this word before the confirm button enables — the
   *  extra friction reserved for the highest-stakes destructions (a bulk delete of
   *  many artifacts at once). Matched case-insensitively, trimmed. Omit for the
   *  ordinary one-click confirm. */
  confirmPhrase?: string
}) {
  const [pending, setPending] = useState(false)
  const [typed, setTyped] = useState("")
  const cancelRef = useRef<HTMLButtonElement>(null)

  // With a phrase, the confirm button stays inert until it's typed — so Enter can't
  // destroy anything by reflex, and a pre-focused button can't be mis-clicked into it.
  const phraseMet = !confirmPhrase || typed.trim().toLowerCase() === confirmPhrase.toLowerCase()

  async function handleConfirm() {
    if (!phraseMet) return
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        // Reset the typed guard whenever the dialog closes, so re-opening it always
        // starts locked — a stale match can't carry over into the next deletion.
        if (!next) setTyped("")
        onOpenChange(next)
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid={contentTestId}
        // Initial focus: the type-to-confirm input when there is one (so you can type
        // straight away), otherwise the LEAST destructive action — Enter can't destroy
        // anything by reflex (the alertdialog convention). The typed button is disabled
        // until matched, so focusing the input doesn't reintroduce a reflex confirm.
        onOpenAutoFocus={(e) => {
          if (confirmPhrase) return
          e.preventDefault()
          cancelRef.current?.focus()
        }}
        // Radix wires aria-describedby to the Description; when none renders,
        // silence the dangling reference (Radix's documented opt-out).
        {...(description ? null : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {confirmPhrase && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-phrase">
              Type <span className="font-mono font-semibold text-foreground">{confirmPhrase}</span>{" "}
              to confirm.
            </Label>
            <Input
              id="confirm-phrase"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder={confirmPhrase}
              data-testid="confirm-dialog-phrase"
              onChange={(e) => setTyped(e.target.value)}
              // Enter submits only once the phrase matches — the same gate the button has.
              onKeyDown={(e) => {
                if (e.key === "Enter" && phraseMet && !pending) handleConfirm()
              }}
            />
          </div>
        )}
        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            data-testid="confirm-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "default"}
            loading={pending}
            disabled={!phraseMet}
            onClick={handleConfirm}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
