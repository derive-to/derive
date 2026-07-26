import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"

// Shown by the router when a route's loader or render throws. The chrome (rail +
// mobile bar) stays mounted above this, so the user can always navigate away.
// Failures go through the ONE status grammar — a centered `StatusPanel` (danger
// tone, which announces `role="alert"`) with the sanctioned quiet actions (outline
// "Try again", like every inline failure; ghost navigate; no filled primary on a
// failure) — so a route-level failure reads the same as an inline list failure.
// "Try again" resets the boundary and re-runs the loader; the raw message is
// dev-only (a thrown error can carry internals).
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const detail = import.meta.env.DEV ? error.message : "Something went wrong loading this page."
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <StatusPanel
        tone="danger"
        icon={<Icon name="removed" strokeWidth={1.75} />}
        title="Couldn’t load this page"
        description={detail}
        className="max-w-md"
        action={
          <div className="flex gap-2">
            <Button
              data-testid="route-error-retry"
              variant="outline"
              onClick={() => {
                reset()
                router.invalidate()
              }}
            >
              Try again
            </Button>
            <Button asChild variant="ghost" data-testid="route-error-home">
              <Link to="/">Go home</Link>
            </Button>
          </div>
        }
      />
    </div>
  )
}

// Navigation landed on a path with no matching route (or a loader called
// notFound()). Not a failure — the thing you asked for isn't there, which is
// emptiness, so it takes the boxless EmptyState voice (matching the artifact
// route's not-found), not the danger StatusPanel that failures use.
export function RouteNotFound() {
  return (
    <EmptyState
      className="flex-1"
      icon={<Icon name="search" strokeWidth={1.75} />}
      title="Page not found"
      description="That link doesn’t point anywhere in this workspace."
      action={
        <Button asChild variant="secondary" data-testid="route-notfound-home">
          <Link to="/">Go home</Link>
        </Button>
      }
    />
  )
}
