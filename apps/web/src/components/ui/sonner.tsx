import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

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
        loading: <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          /* Floating-surface radius register (rounded-xl). */
          "--border-radius": "calc(var(--radius) + 4px)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
        // Sonner ships a hardcoded rgba shadow; route it through the theme shadow
        // tokens instead (soft in light, zeroed in dark — the border carries dark).
        style: { boxShadow: "var(--shadow-pop)" },
      }}
      {...props}
    />
  )
}

export { Toaster }
