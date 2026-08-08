import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { StatusPanel } from "./status-panel"

// The query-failed panel: StatusPanel's danger tone + an outline "Try again"
// wired to refetch. A failure never gets a filled primary — the loud button is
// for the page's real action, not for retrying a fetch (see shared/route-error
// for the same rule on route crashes). One component so every load failure
// reads the same; failure surfaces that need more than a retry (an icon, a
// navigation escape) compose StatusPanel directly.
export function LoadError({
  title,
  testId,
  onRetry,
  description = "This is usually temporary.",
  layout,
  extraAction,
  className,
}: {
  /** "Couldn’t load <the thing>." — name the noun that failed. */
  title: ReactNode
  /** The retry button's data-testid, e.g. "agents-retry". */
  testId: string
  onRetry: () => void
  description?: ReactNode
  layout?: "center" | "inline"
  /** Rendered beside Try again (rare — e.g. a sign-in link). */
  extraAction?: ReactNode
  className?: string
}) {
  const retry = (
    <Button variant="outline" size="sm" data-testid={testId} onClick={onRetry}>
      Try again
    </Button>
  )
  return (
    <StatusPanel
      tone="danger"
      layout={layout}
      title={title}
      description={description}
      className={className}
      action={
        extraAction ? (
          <div className="flex items-center gap-2">
            {retry}
            {extraAction}
          </div>
        ) : (
          retry
        )
      }
    />
  )
}
