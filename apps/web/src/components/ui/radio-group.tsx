"use client"

import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import type * as React from "react"

import { cn } from "@/lib/utils"

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        // Rest = quiet well (bg-secondary + hairline); checked = amber fill, charcoal dot.
        // Color flips are instant (no transition); the after inset keeps a generous touch
        // target without growing the visual box.
        "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input bg-secondary after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Invalid uses destructive; once checked, the amber fill carries its own edge again.
        "aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive aria-invalid:aria-checked:border-primary",
        "data-checked:border-primary data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex size-4 items-center justify-center"
      >
        {/* Charcoal dot on the amber fill — the primary-foreground pairing, never white. */}
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

export { RadioGroup, RadioGroupItem }
