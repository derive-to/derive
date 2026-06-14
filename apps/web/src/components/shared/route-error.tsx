import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"

// Shown by the router when a route's loader or render throws. Without it a
// thrown error blanks the content area (or dumps a stack in dev). The chrome
// (rail + top bar) stays mounted above this, so the user can always navigate
// away. "Try again" resets the boundary and re-runs the loader. The raw message
// is dev-only — a thrown error can carry internals we don't want in prod UI.
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const detail = import.meta.env.DEV ? error.message : "Something went wrong loading this page."
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <Icon name="removed" size={32} className="text-destructive" />
      <div className="space-y-1">
        <p className="font-semibold text-base text-foreground">Couldn't load this page</p>
        <p className="max-w-md text-muted-foreground text-sm">{detail}</p>
      </div>
      <div className="flex gap-2">
        <Button
          data-testid="route-error-retry"
          variant="primary"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          Try again
        </Button>
        <Button asChild variant="outline" data-testid="route-error-home">
          <Link to="/">Go home</Link>
        </Button>
      </div>
    </div>
  )
}

// Shown when navigation lands on a path with no matching route (or a loader
// calls notFound()). Same recoverable shape as RouteError; just an invitation
// back to the library rather than a retry.
export function RouteNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <Icon name="search" size={32} className="text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-semibold text-base text-foreground">Page not found</p>
        <p className="max-w-md text-muted-foreground text-sm">
          That link doesn't point anywhere in this workspace.
        </p>
      </div>
      <Button asChild variant="primary" data-testid="route-notfound-home">
        <Link to="/">Go home</Link>
      </Button>
    </div>
  )
}
