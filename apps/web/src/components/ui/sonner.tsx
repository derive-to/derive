import { CircleCheckIcon, InfoIcon, OctagonXIcon, TriangleAlertIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, toast as sonnerToast, type ToasterProps } from "sonner"
import { Spinner } from "@/components/shared/spinner"

// Toasts are floating surfaces: popover tokens + the hairline edge. With dark-mode
// shadows zeroed, that border IS the elevation cue — --normal-border must stay a
// visible edge in both themes (--border is foreground-at-10%, the ring-foreground/10
// grammar every other floater uses).
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 shrink-0 text-success" />,
        info: <InfoIcon className="size-4 shrink-0 text-muted-foreground" />,
        warning: <TriangleAlertIcon className="size-4 shrink-0 text-warning" />,
        error: <OctagonXIcon className="size-4 shrink-0 text-destructive" />,
        // The house Spinner (one spinner grammar); sonner announces the toast
        // itself, so the glyph is decorative here.
        loading: (
          <Spinner size="sm" className="shrink-0" role="presentation" aria-label={undefined} />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          /* Floating-surface radius register — rounded-xl, matching every other
             floating surface (dropdown, popover, select). */
          "--border-radius": "var(--radius-xl)",
        } as React.CSSProperties
      }
      toastOptions={{
        // Sonner ships a hardcoded rgba shadow; route it through the theme shadow
        // tokens instead (soft in light, zeroed in dark — the border carries dark).
        style: { boxShadow: "var(--shadow-pop)" },
      }}
      {...props}
    />
  )
}

// The house toast layer — all app code imports `toast` from here, never from
// "sonner" directly (biome enforces it). One behavioral opinion: error toasts
// linger 8s (sonner's default 4s is too quick to read a failure and act);
// callers can still override via opts.
const toast = Object.assign((...args: Parameters<typeof sonnerToast>) => sonnerToast(...args), {
  ...sonnerToast,
  error: (
    message: Parameters<typeof sonnerToast.error>[0],
    opts?: Parameters<typeof sonnerToast.error>[1],
  ) => sonnerToast.error(message, { duration: 8000, ...opts }),
})

export { Toaster, toast }
