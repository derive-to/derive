import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// The one "add a row" form above a settings list: a flex-wrap line of controls
// with a single secondary submit at the end, real <form> semantics (Enter in
// any field submits — no per-input onKeyDown), and the button's spinner as the
// only pending signal — no per-form "Adding…" label swaps. Extra content under
// the line (an event-filter row, a CNAME hint, a field error) goes in `after`.
export function AddForm({
  onSubmit,
  submitLabel,
  submitTestId,
  pending = false,
  disabled = false,
  children,
  after,
  className,
}: {
  onSubmit: () => void
  /** A verb: "Add", "Subscribe", "Connect". */
  submitLabel: string
  submitTestId?: string
  pending?: boolean
  disabled?: boolean
  children: ReactNode
  after?: ReactNode
  className?: string
}) {
  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(e) => {
        e.preventDefault()
        if (!disabled && !pending) onSubmit()
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Button
          type="submit"
          data-testid={submitTestId}
          variant="secondary"
          size="sm"
          loading={pending}
          disabled={disabled || pending}
        >
          {submitLabel}
        </Button>
      </div>
      {after}
    </form>
  )
}
