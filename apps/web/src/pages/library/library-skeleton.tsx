import { PageShell } from "@/components/shared/page-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { CardGrid } from "./card-grid"

// One card-shaped placeholder: the live ArtifactCard's box model — a 16:10 preview,
// then a p-3.5 caption of a title line over a two-cluster provenance/activity meta
// row (author dot + time · signals). No border/background/shadow — those arrive
// with the card, and omitting them on the grid's border-box tracks yields zero CLS.
// The geometry comes from CardGrid (the live grid's source), so nothing jumps when
// the artifacts land. Shared by the library grid and the profile work grid.
export function CardSkeletonCell() {
  return (
    <div className="flex flex-col">
      <Skeleton className="aspect-[16/10] rounded-xl" />
      {/* px-3.5 + pt-3.5 mirrors the real card's p-3.5 caption inset. */}
      <div className="flex flex-col gap-2.5 px-3.5 pt-3.5">
        <Skeleton className="h-4 w-3/4" />
        <div className="flex items-center gap-1.5">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="ml-auto h-3 w-10" />
        </div>
      </div>
    </div>
  )
}

const CELLS = ["a", "b", "c", "d", "e", "f", "g", "h"]

// The library's first-load grid placeholder. Skeleton doctrine: the blocks are
// AT-hidden (baked into Skeleton); the REGION announces via role="status" + sr-only.
export function LibrarySkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading library…</span>
      <CardGrid>
        {CELLS.map((k) => (
          <CardSkeletonCell key={k} />
        ))}
      </CardGrid>
    </div>
  )
}

// Route-level pending placeholder (the library routes' pendingComponent): the wide
// PageShell — the real scroll wrapper + measure geometry, not a hand-mirrored copy —
// with a title-band silhouette over the grid. Shown on a cold nav while the loader /
// auth resolve; the in-component LibrarySkeleton (same grid) carries the data load,
// so the two are seamless.
export function LibraryPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <LibrarySkeleton />
    </PageShell>
  )
}
