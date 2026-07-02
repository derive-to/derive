import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A labelled form control: a label above its input, plus optional helper text.
// Pass `htmlFor` (matching the control's id) so the label is properly associated.
// The one canonical label+field rhythm — used by the showcase and new surfaces.
export function FormField({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-2xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
