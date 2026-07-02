import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import type * as React from "react"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Flat tonal chips: rounded-md, no borders on tonal variants (the
  // transparent base border keeps `outline` from shifting layout). A leading
  // icon (data-icon="inline-start") pulls its side in — asymmetric pl-1
  // against the pr-2 base — so the glyph sits optically flush. Sentence-case
  // content assumed. Focus grammar applies when rendered clickable (asChild).
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 text-xs font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // Neutral white-wash is the default — amber is reserved for brand moments.
        default: "bg-accent text-foreground",
        // Deliberate alias of the neutral default — kept as a named variant for API stability.
        secondary: "bg-accent text-foreground",
        brand: "bg-primary/10 text-primary",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border-border text-muted-foreground",
        ghost: "text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
