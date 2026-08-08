import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { StatusPanel } from "./status-panel"

// The query-failed recipe: StatusPanel's danger tone + an OUTLINE "Try again"
// wired to refetch. One component so the grammar can't drift — before this
// existed the copy-pasted versions had already forked on the button variant
// (a filled primary on a failure, against the route-error doctrine), the
// apostrophe, and the description string. Anything beyond a retry (a second
// action, a custom body) composes via the props; genuinely different failure
// surfaces keep using StatusPanel directly.
export function LoadError({
  title,
  testId,
  onRetry,
  description = "This is usually temporary.",
  layout,
  extraAction,
  className,
}: {
  /** "Couldn't load <the thing>." — curly apostrophe, the panel names the noun. */
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
            <Button variant="outline" size="sm" data-testid={testId} onClick={onRetry}>
              Try again
            </Button>
            {extraAction}
          </div>
        ) : (
          <Button variant="outline" size="sm" data-testid={testId} onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  )
}
