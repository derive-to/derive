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
}) {
  const [pending, setPending] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  async function handleConfirm() {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        // Initial focus lands on the LEAST destructive action — Enter can't
        // destroy anything by reflex (the alertdialog convention).
        onOpenAutoFocus={(e) => {
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
