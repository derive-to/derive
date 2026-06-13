import { Slot } from "@radix-ui/react-slot"
import { type VariantProps, cva } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-border bg-card text-foreground hover:border-primary hover:text-primary",
        primary: "border border-primary bg-primary text-primary-foreground hover:brightness-105",
        secondary: "bg-secondary text-secondary-foreground hover:bg-hover",
        ghost: "text-foreground hover:bg-hover",
        outline: "border border-border text-foreground hover:bg-hover",
        destructive: "bg-destructive text-destructive-foreground hover:brightness-105",
        link: "text-primary underline-offset-2 hover:underline",
      },
      size: {
        sm: "h-7 rounded-[8px] px-2.5 text-xs",
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

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
}

export { buttonVariants }
