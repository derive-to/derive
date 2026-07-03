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
        // Native picker glyphs follow the theme via color-scheme on :root/.dark.
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 shadow-(--shadow-sm) outline-none selection:bg-selection dark:bg-input/30",
        // WebKit autofill paints an opaque yellow well — repaint it with the theme
        // canvas + ink so autofilled fields stay legible in both themes.
        "autofill:shadow-[inset_0_0_0_1000px_var(--background)] autofill:[-webkit-text-fill-color:var(--foreground)]",
        // iOS no-zoom: fields stay ≥16px on touch; 14px control base from sm up.
        "text-base placeholder:text-muted-foreground sm:text-sm",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        // Editable focus grammar: ink border + soft glow, never outline-offset.
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
