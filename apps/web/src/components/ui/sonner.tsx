import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// App toast surface. One <Toaster/> is mounted at the root (see __root.tsx);
// everywhere else just calls `toast()` / `toast.success()` / `toast.error()`
// from "sonner" — the singleton means no provider and no prop-drilling. The
// --normal-* vars theme the neutral toast from our [data-theme] tokens (so it
// matches Paper/Light/Dark/Dusk); richColors gives success/error their own
// palette. bottom-center preserves the prior toast position.
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-center"
      richColors
      style={
        {
          "--normal-bg": "var(--color-popover)",
          "--normal-text": "var(--color-popover-foreground)",
          "--normal-border": "var(--color-border)",
        } as CSSProperties
      }
      {...props}
    />
  )
}
