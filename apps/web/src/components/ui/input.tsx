import type * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Quiet well: hairline border-input; transparent on light (the themed shadow
        // var adds depth there and zeroes in dark, where the well fill does the work).
        // scheme-dark keeps native date/time picker glyphs legible on charcoal.
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 shadow-(--shadow-sm) outline-none selection:bg-selection dark:bg-input/30 dark:scheme-dark",
        // iOS no-zoom: fields stay ≥16px on touch; 14px control base from sm up.
        "text-base placeholder:text-muted-foreground sm:text-sm",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        // Editable focus grammar: amber border + soft glow, never outline-offset.
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        "disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:disabled:bg-input/80",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
