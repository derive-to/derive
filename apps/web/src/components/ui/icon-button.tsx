import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"
import { cn } from "@/lib/utils"

// A square, icon-only button — the single home for the "grid place-items-center
// rounded-md" chips that were re-typed across the card, comment, and toolbar
// surfaces. `ghost` is the bare action (chrome, toolbars); `chip` is the bordered
// overlay (card corners). forwardRef so it can be a Radix trigger via asChild.
// Callers pass an <Icon/> child and an aria-label.
const iconButtonVariants = cva(
  "grid shrink-0 place-items-center rounded-md transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-95",
  {
    variants: {
      variant: {
        ghost: "text-muted-foreground hover:bg-hover hover:text-foreground",
        chip: "border border-border bg-card text-muted-foreground hover:bg-hover",
      },
      size: {
        sm: "size-6",
        md: "size-7",
        lg: "size-8",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
)

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
IconButton.displayName = "IconButton"

export { iconButtonVariants }
