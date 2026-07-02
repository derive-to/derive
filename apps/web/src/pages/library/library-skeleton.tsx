import { Skeleton } from "@/components/ui/skeleton"

// Card-grid placeholder for the library's first load: plain bg-muted blocks —
// a skeleton never draws card chrome — mirroring the live grid's geometry
// (16:10 thumb, then title + meta lines) so nothing jumps when the artifacts
// arrive. Same asymmetric gutter as the live grid.
export function LibrarySkeleton() {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3 gap-y-5"
      aria-hidden
    >
      {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
        <div key={k} className="flex flex-col gap-3">
          <Skeleton className="aspect-[16/10] rounded-xl" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
