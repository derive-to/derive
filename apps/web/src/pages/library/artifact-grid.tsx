import { useVirtualizer } from "@tanstack/react-virtual"
import { type RefObject, useEffect, useRef, useState } from "react"
import type { Artifact } from "@/api"
import { ArtifactCard } from "./artifact-card"

// Grid geometry: cards are `minmax(220px, 1fr)` with a 12px (gap-3) gutter. We
// virtualize ROWS (each row = `columns` cards), so we derive the column count
// from the measured width and let react-virtual render only the visible rows.
const MIN_CARD = 220
const GAP = 12
const EST_ROW = 168 // card (~156) + gap; measureElement corrects per row

// The library grid, windowed. Only the rows in (or near) the viewport are in the
// DOM, so the grid stays at 60fps no matter how large the library grows. The
// last row entering view pulls the next page (infinite scroll).
export function ArtifactGrid({
  items,
  scrollRef,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onOpen,
  onToggleFavorite,
  onPickTag,
  onDelete,
  onPrefetch,
}: {
  items: Artifact[]
  // The scrolling ancestor (the library's overflow-y-auto container).
  scrollRef: RefObject<HTMLDivElement | null>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickTag: (tag: string) => void
  onDelete: (a: Artifact) => void
  onPrefetch: (a: Artifact) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  const [scrollMargin, setScrollMargin] = useState(0)

  // How many cards fit per row, and how far the grid sits below the scroll
  // container's top (everything above it — search, publish card, heading — is
  // the virtualizer's scrollMargin). Both recompute on resize.
  useEffect(() => {
    const grid = gridRef.current
    const scroll = scrollRef.current
    if (!grid || !scroll) return
    const measure = () => {
      const w = grid.clientWidth
      setColumns(Math.max(1, Math.floor((w + GAP) / (MIN_CARD + GAP))))
      setScrollMargin(
        grid.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(grid)
    ro.observe(scroll)
    return () => ro.disconnect()
  }, [scrollRef])

  const rowCount = Math.ceil(items.length / columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => EST_ROW,
    overscan: 3,
    scrollMargin,
  })

  // Infinite scroll: once the final row is rendered (in view + overscan), pull
  // the next page if there is one.
  const virtualRows = virtualizer.getVirtualItems()
  const lastIndex = virtualRows.at(-1)?.index ?? 0
  useEffect(() => {
    if (lastIndex >= rowCount - 1 && hasNextPage && !isFetchingNextPage) onLoadMore()
  }, [lastIndex, rowCount, hasNextPage, isFetchingNextPage, onLoadMore])

  return (
    <div ref={gridRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualRows.map((vrow) => {
        const start = vrow.index * columns
        const rowItems = items.slice(start, start + columns)
        return (
          <div
            key={vrow.key}
            data-index={vrow.index}
            ref={virtualizer.measureElement}
            className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vrow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {rowItems.map((a) => (
              <ArtifactCard
                key={a.short_id}
                artifact={a}
                onOpen={() => onOpen(a)}
                onToggleFavorite={() => onToggleFavorite(a)}
                onPickTag={onPickTag}
                onDelete={() => onDelete(a)}
                onPrefetch={() => onPrefetch(a)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
