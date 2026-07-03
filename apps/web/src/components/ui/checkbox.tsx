"use client"

import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // Rest = quiet well (bg-secondary + hairline); checked = ink fill with a primary-foreground
        // glyph — never a hardcoded white on ink. Color flips are instant (no transition); the after
        // inset keeps a generous touch target without growing the visual box.
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-secondary after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 group-has-disabled/field:opacity-50",
        // Invalid uses destructive; once checked, the ink fill carries its own edge again.
        "aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive aria-invalid:aria-checked:border-primary",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current [&>svg]:size-3"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
