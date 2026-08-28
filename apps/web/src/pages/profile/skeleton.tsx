import { CardGrid } from "@/components/shared/card-grid"
import { PageShell } from "@/components/shared/page-shell"
import { SectionHeading } from "@/components/shared/section-title"
import { Skeleton } from "@/components/ui/skeleton"
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

// The profile's first-load frame: the identity-header silhouette over the real static
// "Work" eyebrow and a CardSkeletonCell grid. Reserves ONLY the always-present spine —
// avatar, name line, @handle line, Follow-button block, and the stats row — and NOT the
// optional profession/bio, which vary per profile: reserving them would over-tall a
// sparse profile and shift it UP when the real (shorter) header lands. The optional lines
// are additive, so a fuller profile grows DOWN (the natural direction) instead. Since the
// header is preloaded in the route loader, this only ever shows on a genuine cold load.
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
            {/* Stats row (works / followers / following) — the next always-present line
                after the handle. Profession + bio are deliberately not reserved. */}
            <div className="mt-4 flex items-center gap-5">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        </div>
      </section>

      {/* The Work section: the real static heading (always "Work") over the grid
          silhouette, matching ProfileWork's own `flex flex-col gap-3` section. */}
      <section className="flex flex-col gap-3">
        <SectionHeading>Work</SectionHeading>
        <ProfileWorkSkeleton />
      </section>
    </PageShell>
  )
}
