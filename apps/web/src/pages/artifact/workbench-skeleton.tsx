import { Spinner } from "@/components/shared/spinner"
import { Skeleton } from "@/components/ui/skeleton"

// The artifact workbench, shape-matched: the document header (title over a
// machine-state line on the left, the Share/★/⋯ action cluster on the right —
// mirroring the live header box model in artifact/index.tsx: the same
// border-b + px-4 py-2.5 container and the h-8 button cluster that drives its
// height, so the chrome never jumps) over the edge-to-edge render stage. The
// render surface itself can't be skeletonized (arbitrary iframe HTML), so it shows
// the same calm boot spinner the live RenderStage uses — on the app canvas, never a
// white flash. Serves as the /artifacts/$ref route pendingComponent AND replaces
// the old bare centered ArtifactLoading spinner.
export function WorkbenchSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" role="status">
      <span className="sr-only">Loading artifact…</span>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 max-sm:px-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-2.5 w-32" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-8 w-16 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
        </div>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" role="presentation" aria-label={undefined} />
          <span className="font-mono text-2xs text-muted-foreground">Loading preview…</span>
        </div>
      </div>
    </div>
  )
}
