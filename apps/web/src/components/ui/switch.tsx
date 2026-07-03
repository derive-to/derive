"use client"

import { Switch as SwitchPrimitive } from "radix-ui"
import type * as React from "react"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // Track rest = quiet well with an inset hairline (the house track idiom); checked
        // commits to ink and drops the edge. The transparent border only preserves the
        // geometry the thumb translate math depends on. Color flips are instant; the after
        // inset keeps a generous touch target.
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent bg-secondary inset-ring inset-ring-input after:absolute after:-inset-x-3 after:-inset-y-2 data-checked:bg-primary data-checked:inset-ring-transparent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:inset-ring-destructive aria-invalid:focus-visible:outline-destructive aria-invalid:data-checked:inset-ring-destructive",
        "data-[size=default]:h-4.5 data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {/* Thumb: foreground at rest → primary-foreground on the ink track when checked (the brand-checked
          pairing — never a hardcoded white on ink). Only the translate transitions: movement is allowed. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-foreground transition-transform data-checked:bg-primary-foreground group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
