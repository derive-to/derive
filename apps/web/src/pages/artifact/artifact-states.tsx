import { useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApiMutation } from "@/lib/use-api-mutation"

/** Full-page states the artifact route renders instead of the doc. The loading
 *  frame is the shape-matched WorkbenchSkeleton (workbench-skeleton.tsx), not a
 *  bare spinner. */

/**
 * The wall. Its wording is deliberately ambiguous and has to stay that way: the server
 * answers a forbidden artifact and a nonexistent one identically so nobody can walk the
 * short-id space, and a screen that only offered to ask when there was something to ask
 * for would hand back that oracle from the client instead.
 *
 * So the ask renders unconditionally, and the confirmation promises only what we can
 * honestly claim — that it was passed on, not that anyone received it. `shortId` is
 * absent when the route never resolved one; then there is nothing to ask about and this
 * degrades to the old dead end.
 */
export function ArtifactNotFound({ shortId, onBack }: { shortId?: string; onBack: () => void }) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState("")
  const [sent, setSent] = useState(false)
  const requestAccess = useApiMutation({
    // The API resolves 202 for every case; a rejection here is the network, not a refusal.
    mutationFn: () => api.requestArtifactAccess(shortId ?? "", note.trim() || undefined),
    onSuccess: () => setSent(true),
  })

  return (
    <EmptyState
      className="h-full"
      icon={<Icon name={sent ? "check" : "removed"} strokeWidth={1.75} />}
      title={sent ? "Request sent" : "Artifact not found"}
      description={
        sent
          ? "If this artifact exists and someone can grant access, they’ve been asked. You’ll get an email if they say yes."
          : "It doesn’t exist, or you don’t have access to it."
      }
      action={
        sent ? (
          <Button variant="outline" data-testid="artifact-notfound-back" onClick={onBack}>
            Back to library
          </Button>
        ) : (
          <div className="flex w-full max-w-sm flex-col gap-2">
            {asking && (
              <Input
                autoFocus
                data-testid="artifact-access-note"
                maxLength={280}
                value={note}
                placeholder="Add a note (optional) — who you are, why you need it"
                onChange={(e) => setNote(e.target.value)}
              />
            )}
            <div className="flex justify-center gap-2">
              {shortId && (
                <Button
                  data-testid="artifact-access-request"
                  disabled={requestAccess.isPending}
                  onClick={() => (asking ? requestAccess.mutate(undefined) : setAsking(true))}
                >
                  Request access
                </Button>
              )}
              <Button variant="outline" data-testid="artifact-notfound-back" onClick={onBack}>
                Back to library
              </Button>
            </div>
          </div>
        )
      }
    />
  )
}

export function ArtifactWrongWorkspace({
  workspaceName,
  onSwitch,
  onBack,
}: {
  workspaceName: string
  onSwitch: () => void
  onBack: () => void
}) {
  return (
    <EmptyState
      className="h-full"
      icon={<Icon name="workspace" strokeWidth={1.75} />}
      title={`Switch to ${workspaceName}`}
      description={`This artifact belongs to ${workspaceName}. Switch workspaces to view it.`}
      action={
        <div className="flex gap-2">
          <Button data-testid="artifact-workspace-switch" onClick={onSwitch}>
            Switch to {workspaceName}
          </Button>
          <Button variant="outline" data-testid="artifact-workspace-back" onClick={onBack}>
            Back to library
          </Button>
        </div>
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
