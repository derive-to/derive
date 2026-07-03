import { Skeleton } from "@/components/ui/skeleton"
import { CardGrid } from "./card-grid"

// Card-grid placeholder for the library's first load: plain bg-muted blocks — a
// skeleton never draws card chrome — mirroring the live grid's geometry (16:10
// preview, then title + meta lines) so nothing jumps when the artifacts arrive.
// The geometry itself comes from CardGrid, the live grid's source. Skeleton
// doctrine: the blocks are hidden from AT (baked into Skeleton); the REGION
// announces the load via role="status" + sr-only text.
export function LibrarySkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading library…</span>
      <CardGrid>
        {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
          <div key={k} className="flex flex-col">
            <Skeleton className="aspect-[16/10] rounded-xl" />
            {/* px-3.5 + pt-3.5 stands in for the real card's p-3.5 caption inset (matching
                the horizontal inset so the title doesn't shift right when content arrives). */}
            <div className="flex flex-col gap-2.5 px-3.5 pt-3.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </CardGrid>
    </div>
  )
}
