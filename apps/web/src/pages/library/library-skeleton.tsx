import { Skeleton } from "@/components/ui/skeleton"

// Card-grid placeholder for the library's first load. Mirrors the REAL card box
// model exactly — full-bleed 16:10 thumb, then a border-t content block — so nothing
// jumps when the artifacts arrive. Same asymmetric gutter as the live grid.
export function LibrarySkeleton() {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3 gap-y-5"
      aria-hidden
    >
      {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
        <div
          key={k}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <Skeleton className="aspect-[16/10] rounded-none" />
          <div className="flex flex-col gap-2 border-t border-border-soft p-3.5">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
