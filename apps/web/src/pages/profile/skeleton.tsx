import { PageShell } from "@/components/shared/page-shell"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Skeleton } from "@/components/ui/skeleton"
import { CardGrid } from "../library/card-grid"
import { CardSkeletonCell } from "../library/library-skeleton"

const WORK_CELLS = ["a", "b", "c", "d", "e", "f"]

// The profile Work grid's first-load placeholder — the SAME CardGrid geometry +
// CardSkeletonCell the resolved grid uses, so nothing jumps when the work lands.
// Bare (no live region): the consumer owns the status announcement so a page-level
// load doesn't double-announce. Shared by ProfilePending (cold nav) and ProfileWork's
// own in-component first load.
export function ProfileWorkSkeleton() {
  return (
    <CardGrid>
      {WORK_CELLS.map((k) => (
        <CardSkeletonCell key={k} />
      ))}
    </CardGrid>
  )
}

// The profile's first-load frame: the identity-header silhouette (a round avatar, the
// name + @handle lines, a Follow-button-sized block, a profession line, a two-line bio,
// and a stats row) over the real static "Work" eyebrow and a CardSkeletonCell grid.
// Mirrors profile.tsx's box model (dims, gaps, radius, counts) but never its
// borders/backgrounds/shadows — those arrive with the content, so omitting them yields
// zero CLS. Used both as the route pendingComponent and the Profile component's
// in-component first-load state, so the two are seamless.
export function ProfilePending() {
  return (
    <PageShell className="flex flex-col gap-8">
      <span role="status" className="sr-only">
        Loading profile…
      </span>
      <section>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
          {/* Avatar: size-20 sm:size-24, round. */}
          <Skeleton className="size-20 shrink-0 rounded-full sm:size-24" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-2">
                {/* Name (font-serif text-2xl) over @handle (text-sm). */}
                <Skeleton className="h-7 w-44" />
                <Skeleton className="h-4 w-28" />
              </div>
              {/* Follow button (size sm → h-8, rounded-lg). */}
              <Skeleton className="h-8 w-20 shrink-0 rounded-lg" />
            </div>
            {/* Profession. */}
            <Skeleton className="mt-3 h-4 w-40" />
            {/* Bio (two lines). */}
            <div className="mt-2 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            {/* Stats row (works / followers / following). */}
            <div className="mt-4 flex items-center gap-5">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        </div>
      </section>

      {/* The Work section: the real static eyebrow (always "Work") over the grid
          silhouette, matching ProfileWork's own `flex flex-col gap-3` section. */}
      <section className="flex flex-col gap-3">
        <SectionEyebrow>Work</SectionEyebrow>
        <ProfileWorkSkeleton />
      </section>
    </PageShell>
  )
}
