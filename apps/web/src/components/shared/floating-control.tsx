import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// A control that floats over the sandboxed render (the comments FAB, the focus-mode
// exit, the "comment on selection" pill). The render is an opaque white iframe, so
// the fill must stay OPAQUE: the outline/ghost hover washes are meant to sit over a
// surface and would erase a pill floating over the iframe. So composite the neutral
// hover step into the opaque card instead (darkens in light, lightens in dark — the
// same ink direction as --secondary). One recipe so every floating control matches.
export function FloatingControl({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      className={cn(
        "rounded-full bg-card shadow-[var(--shadow)] hover:bg-[color-mix(in_oklab,var(--card)_95%,var(--foreground))]",
        className,
      )}
      {...props}
    />
  )
}
