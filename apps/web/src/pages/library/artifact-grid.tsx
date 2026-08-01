import { useVirtualizer } from "@tanstack/react-virtual"
import { type RefObject, useEffect, useRef, useState } from "react"
import type { Artifact } from "@/api"
import { CARD_GRID_COLS, MIN_CARD_PX } from "@/components/shared/card-grid"
import { cn } from "@/lib/utils"
import { ArtifactCard } from "./artifact-card"
import { ArtifactRow } from "./artifact-row"
import type { LibrarySelection } from "./use-library-selection"

// Grid geometry comes from card-grid.tsx (one source with the live grid and the
// skeleton). We virtualize ROWS (each row = `columns` cards), so we derive the
// column count from the measured width and let react-virtual render only the
// visible rows.
const GAP = 16
// Initial row estimate for a preview-first 16:10 card (~163px preview at a 3-up
// width + ~72px caption + the 24px row gutter); measureElement corrects the real
// height per row once mounted.
const EST_ROW = 260
// A list row is title + one meta line; the virtualizer measures the real height on
// first paint, so this only has to be close enough to avoid a scrollbar jump.
const EST_LIST_ROW = 52

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
  onAddToCollection,
  onDelete,
  onPrefetch,
  selection,
  layout = "grid",
  onPickAuthor,
}: {
  items: Artifact[]
  // The scrolling ancestor (the library's overflow-y-auto container).
  scrollRef: RefObject<HTMLDivElement | null>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onAddToCollection: (a: Artifact) => void
  onDelete: (a: Artifact) => void
  onPrefetch: (a: Artifact) => void
  // Multi-select. The grid only threads it through: the set lives in the library body,
  // so it survives the virtualizer recycling a card out of the DOM on scroll.
  selection?: LibrarySelection
  /** Grid of cards, or a dense row list — a remembered preference (see the library's
   *  `layout`). Both go through this virtualizer: list mode is for large collections,
   *  which is exactly where an unvirtualized path would hurt. */
  layout?: "grid" | "list"
  onPickAuthor?: (login: string) => void
}) {
  const list = layout === "list"
  const gridRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  const [scrollMargin, setScrollMargin] = useState(0)

  // How many cards fit per row, and how far the grid sits below the scroll
  // container's top (everything above it — search, publish card, heading — is
  // the virtualizer's scrollMargin). Recompute on resize AND on any above-grid
  // height change: we observe the scroll container, the grid, and the scroll
  // container's content wrapper (the PageShell measure element). That last one is
  // the key — when content ABOVE the grid changes height (a header greeting/triage
  // landing, filter pills wrapping) the grid moves without resizing itself, so
  // observing only the grid would leave scrollMargin stale and every windowed row
  // translated to the wrong offset. The wrapper's height DOES change, so observing
  // it catches the drift.
  useEffect(() => {
    const grid = gridRef.current
    const scroll = scrollRef.current
    if (!grid || !scroll) return
    const measure = () => {
      const w = grid.clientWidth
      setColumns(list ? 1 : Math.max(1, Math.floor((w + GAP) / (MIN_CARD_PX + GAP))))
      setScrollMargin(
        grid.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(grid)
    ro.observe(scroll)
    // The content wrapper between the scroll top and the grid — its height changes
    // whenever above-grid content does, which a grid-only observer misses.
    if (scroll.firstElementChild) ro.observe(scroll.firstElementChild)
    return () => ro.disconnect()
  }, [scrollRef, list])

  const rowCount = Math.ceil(items.length / columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (list ? EST_LIST_ROW : EST_ROW),
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
    <div ref={gridRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualRows.map((vrow) => {
        const start = vrow.index * columns
        const rowItems = items.slice(start, start + columns)
        return (
          <div
            key={vrow.key}
            data-index={vrow.index}
            ref={virtualizer.measureElement}
            // Asymmetric gutter: a wider vertical gap (pb-6, measured into the row)
            // than the horizontal gap-x-4, so captions get air before the next row's
            // preview — reads as a curated gallery, not a tight data grid.
            className={cn(
              "absolute top-0 left-0 w-full",
              // List is a dense register: no gallery gutter, a hairline between rows.
              list ? "border-b border-border-soft" : cn(CARD_GRID_COLS, "gap-x-4 pb-6"),
            )}
            style={{
              transform: `translateY(${vrow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {rowItems.map((a) =>
              list ? (
                <ArtifactRow
                  key={a.short_id}
                  artifact={a}
                  onOpen={() => onOpen(a)}
                  onToggleFavorite={() => onToggleFavorite(a)}
                  onPickAuthor={onPickAuthor}
                  onAddToCollection={() => onAddToCollection(a)}
                  onDelete={() => onDelete(a)}
                  onPrefetch={() => onPrefetch(a)}
                  selected={selection?.selected.has(a.short_id)}
                  selectionActive={selection?.active}
                  onSelect={selection ? (shift) => selection.toggle(a.short_id, shift) : undefined}
                />
              ) : (
                <ArtifactCard
                  key={a.short_id}
                  artifact={a}
                  onOpen={() => onOpen(a)}
                  onToggleFavorite={() => onToggleFavorite(a)}
                  onAddToCollection={() => onAddToCollection(a)}
                  onDelete={() => onDelete(a)}
                  onPrefetch={() => onPrefetch(a)}
                  selected={selection?.selected.has(a.short_id)}
                  selectionActive={selection?.active}
                  onSelect={selection ? (shift) => selection.toggle(a.short_id, shift) : undefined}
                />
              ),
            )}
          </div>
        )
      })}
    </div>
  )
}
