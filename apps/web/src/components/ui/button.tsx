import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import type * as React from "react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // Clickable focus grammar: solid amber outline, offset — never a ring glow.
  // Color hovers are instant (no transition-*); the press translate is the
  // only motion, and it is suppressed on menu triggers (aria-haspopup) so
  // open panels don't jitter.
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Amber chassis: charcoal text (never white on amber); the inset
        // top-light reads as a lit edge on the fill in BOTH themes. Hover steps
        // the fill toward the theme's canvas direction — darker in light (the
        // brand-50 label needs the contrast), lighter in dark (an opacity step
        // over the dark canvas would read darker, so mix toward white).
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_--theme(--color-white/20%)] hover:bg-[color-mix(in_oklab,var(--primary)_92%,black)] dark:hover:bg-[color-mix(in_oklab,var(--primary)_88%,white)]",
        // Hairline only; hover is a quiet neutral wash, never amber.
        outline: "border-border hover:bg-secondary aria-expanded:bg-secondary",
        // Quiet well + hairline; hover brightens the edge (neutral, not ring).
        secondary:
          "border-input bg-secondary text-secondary-foreground hover:border-foreground/25 aria-expanded:border-foreground/25",
        ghost:
          "hover:bg-secondary hover:text-foreground aria-expanded:bg-secondary aria-expanded:text-foreground",
        // Soft, quiet delete — destructive intent is confirmed in a dialog,
        // never announced with a loud red fill.
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/15",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-7 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-10 gap-2 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs":
          "size-7 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
