import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // Medium weight (not semibold), a quiet 150ms transition, and a faint press.
  // Emphasis comes from fill + a soft resting shadow, hover from a subtle shift —
  // never an ink-flip. Focus stays a clear ring for a11y.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-border bg-card text-foreground hover:bg-hover",
        primary: "bg-primary text-primary-foreground shadow-[var(--shadow-sm)] hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-hover",
        ghost: "text-foreground hover:bg-hover",
        outline: "border border-border text-foreground hover:bg-hover",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[var(--shadow-sm)] hover:bg-destructive/90",
        link: "text-primary underline-offset-2 hover:underline active:scale-100",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        default: "h-9 px-3.5 text-sm",
        lg: "h-10 px-5 text-base",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

// forwardRef is required so Radix can attach its positioning ref when Button is
// used as a Popover/DropdownMenu/Dialog trigger via `asChild`. Without it the
// floating content can't measure the trigger and renders off-screen.
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    )
  },
)
Button.displayName = "Button"

export { buttonVariants }
