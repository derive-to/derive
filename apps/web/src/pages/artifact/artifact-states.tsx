import { Icon } from "@/components/icons"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"

/** Full-page states the artifact route renders before (or instead of) the doc. */

export function ArtifactLoading() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  )
}

export function ArtifactNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="grid h-full place-items-center gap-2.5">
      <div className="text-muted-foreground">Artifact not found, or you don't have access.</div>
      <Button variant="outline" data-testid="artifact-notfound-back" onClick={onBack}>
        Back to library
      </Button>
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
    <div className="grid h-full place-items-center gap-3 text-center">
      <Icon name="removed" size={40} className="opacity-55" />
      <div className="text-lg font-semibold">This artifact was removed</div>
      <div className="max-w-[360px] text-sm leading-relaxed text-muted-foreground">
        It was taken down by a moderator and is no longer available.
      </div>
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
    </div>
  )
}
