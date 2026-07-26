import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"

/** Full-page states the artifact route renders instead of the doc. The loading
 *  frame is the shape-matched WorkbenchSkeleton (workbench-skeleton.tsx), not a
 *  bare spinner. */

export function ArtifactNotFound({ onBack }: { onBack: () => void }) {
  return (
    <EmptyState
      className="h-full"
      icon={<Icon name="removed" strokeWidth={1.75} />}
      title="Artifact not found"
      description="It doesn’t exist, or you don’t have access to it."
      action={
        <Button variant="outline" data-testid="artifact-notfound-back" onClick={onBack}>
          Back to library
        </Button>
      }
    />
  )
}

// A TRANSIENT failure (network blip, a 5xx, the server briefly unhealthy) — distinct
// from a real 404/403. The query already auto-retries with backoff; this is the
// recoverable fallback once those are exhausted, so the page comes back with one
// click instead of dead-ending on "not found". Deliberately NOT the boxless
// empty-state voice — an error is tool chrome, so the headline stays Geist.
export function ArtifactLoadError({
  onRetry,
  onBack,
}: {
  onRetry: () => void
  onBack: () => void
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <StatusPanel
        tone="danger"
        icon={<Icon name="removed" strokeWidth={1.75} />}
        title="Couldn’t load this artifact"
        description="Something went wrong reaching the server. This is usually temporary."
        className="max-w-md"
        action={
          <div className="flex gap-2">
            <Button variant="outline" data-testid="artifact-load-retry" onClick={onRetry}>
              Try again
            </Button>
            <Button variant="ghost" data-testid="artifact-load-back" onClick={onBack}>
              Back to library
            </Button>
          </div>
        }
      />
    </div>
  )
}

// A taken-down artifact: content is gone (the server 410s the raw routes), but an
// owner can still reinstate it.
export function ArtifactRemoved({
  canReinstate,
  onReinstate,
  onBack,
}: {
  canReinstate: boolean
  onReinstate: () => void
  onBack: () => void
}) {
  return (
    <EmptyState
      className="h-full"
      icon={<Icon name="removed" strokeWidth={1.75} />}
      title="This artifact was removed"
      description="It was taken down by a moderator and is no longer available."
      action={
        <div className="flex gap-2">
          {canReinstate && (
            <Button variant="outline" data-testid="artifact-reinstate" onClick={onReinstate}>
              Reinstate
            </Button>
          )}
          <Button variant="outline" data-testid="artifact-removed-back" onClick={onBack}>
            Back to library
          </Button>
        </div>
      }
    />
  )
}
