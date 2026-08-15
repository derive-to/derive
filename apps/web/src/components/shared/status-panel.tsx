import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A status callout for a transient or degraded condition — a failed load, a state
// worth surfacing. Deliberately distinct from EmptyState's boxless "there's simply
// nothing here", so an error never reads as an empty library. Tone grammar:
// bg-<tone>/10 fill + ring-1 ring-inset ring-<tone>/25 edge — a tint, never a loud
// fill. Neutral stays a quiet well; success/warning/danger are the status hues;
// brand is for brand moments (sync, upgrade nudges) — the ink accent is not a status.
//
// Two layouts: "center" (default) for page-level states, and "inline" for
// left-aligned callouts (warning banners, token reveals, form errors) — icon +
// title + body + one plain action. One component so the tone grammar can't drift.
type Tone = "neutral" | "brand" | "success" | "warning" | "danger"

const TONES: Record<Tone, { panel: string; title: string }> = {
  neutral: { panel: "bg-muted ring-border", title: "text-foreground" },
  brand: { panel: "bg-primary/10 ring-primary/25", title: "text-primary" },
  success: { panel: "bg-success/10 ring-success/25", title: "text-success" },
  warning: { panel: "bg-warning/10 ring-warning/25", title: "text-warning" },
  danger: { panel: "bg-destructive/10 ring-destructive/25", title: "text-destructive" },
}

export function StatusPanel({
  tone = "neutral",
  layout = "center",
  icon,
  title,
  description,
  action,
  className,
}: {
  tone?: Tone
  layout?: "center" | "inline" | "compact"
  /** A size-4 lucide glyph; tinted with the tone ink. */
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  // Danger is announced assertively (role="alert"); everything else stays a
  // polite status — the live-region grammar, not just a visual tone.
  const role = tone === "danger" ? "alert" : "status"

  if (layout === "compact") {
    return (
      <div
        role={role}
        className={cn(
          "flex flex-col gap-3 rounded-xl p-3 ring-1 ring-inset sm:flex-row sm:items-center",
          TONES[tone].panel,
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {icon ? (
            <div
              className={cn("flex h-lh shrink-0 items-center [&_svg]:size-4", TONES[tone].title)}
            >
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 text-sm">
            <p className={cn("font-medium", TONES[tone].title)}>{title}</p>
            {description ? (
              <p className="mt-0.5 text-pretty text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0 sm:self-center">{action}</div> : null}
      </div>
    )
  }

  if (layout === "inline") {
    return (
      <div
        role={role}
        className={cn(
          "flex items-start gap-3 rounded-xl p-4 ring-1 ring-inset",
          TONES[tone].panel,
          className,
        )}
      >
        {icon && (
          <div
            className={cn(
              "flex h-lh shrink-0 items-center text-sm [&_svg]:size-4",
              TONES[tone].title,
            )}
          >
            {icon}
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex flex-col gap-1 text-sm">
            <p className={cn("font-medium", TONES[tone].title)}>{title}</p>
            {description && <p className="text-pretty text-muted-foreground">{description}</p>}
          </div>
          {action && <div>{action}</div>}
        </div>
      </div>
    )
  }

  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl p-8 text-center ring-1 ring-inset",
        TONES[tone].panel,
        className,
      )}
    >
      <div className="flex flex-col items-center gap-2">
        {/* Page-level (center) states take the editorial size-6 glyph, not the meta
            size-4 the inline layout uses — pass strokeWidth={1.75} at the call site. */}
        {icon && (
          <div className={cn("[&_svg:not([class*='size-'])]:size-6", TONES[tone].title)}>
            {icon}
          </div>
        )}
        <p className={cn("font-medium", TONES[tone].title)}>{title}</p>
        {description && <p className="max-w-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
