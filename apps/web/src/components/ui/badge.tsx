import { type VariantProps, cva } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-border-soft bg-secondary text-muted-foreground",
        primary: "border-primary bg-primary text-primary-foreground",
        accent: "border-transparent bg-accent text-accent-foreground",
        success: "border-transparent bg-secondary text-success",
        outline: "border-border text-foreground",
      },
      size: {
        default: "px-1.5 py-px text-2xs",
        sm: "px-1.5 py-px text-2xs",
        md: "px-2 py-0.5 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export { badgeVariants }
