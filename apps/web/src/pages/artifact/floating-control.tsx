import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// A control that floats over the sandboxed render (the comments FAB, the focus-mode
// exit). It carries the floating-surface grammar — opaque bg-card + `ring-1
// ring-foreground/10` + shadow — so it matches menus, popovers, and the render mat
// rather than the plain button outline. The fill must stay OPAQUE: the ghost hover
// wash is meant to sit over a surface and would erase a pill floating over the opaque
// iframe, so composite the neutral hover step into the card instead (darkens in light,
// lightens in dark — the `--secondary` ink direction). One recipe, every control matches.
export function FloatingControl({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      className={cn(
        "rounded-full bg-card shadow-[var(--shadow)] ring-1 ring-foreground/10 hover:bg-[color-mix(in_oklab,var(--card)_95%,var(--foreground))]",
        className,
      )}
      {...props}
    />
  )
}
