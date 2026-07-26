import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Artifact } from "@/api"

// Multi-select for the library. The set holds short_ids — the identity every library
// surface already keys on (cards, rows, caches) — and the anchor drives shift-click
// range selection against the CURRENT feed order, so "everything between these two"
// means what you can see, not what the server happened to return.
//
// A selection belongs to ONE feed: switch the tab, filter, or search and it clears.
// Carrying ids across a filter change would leave the bar counting artifacts that are
// no longer on screen, and a bulk write is the last place to be vague about its scope.
export function useLibrarySelection(items: Artifact[], feedKey: string) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // The last card clicked WITHOUT shift — the fixed end of a shift-click range.
  const anchor = useRef<string | null>(null)

  const clear = useCallback(() => {
    anchor.current = null
    setSelected((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])

  // Reset DURING render, not in an effect ("You Might Not Need an Effect" → adjusting
  // state when a prop changes). An effect would paint one frame of the old selection
  // over the new feed — the bar briefly claiming artifacts that aren't on screen — and
  // that frame is exactly the confusion this reset exists to prevent.
  const [feedAtSelection, setFeedAtSelection] = useState(feedKey)
  if (feedKey !== feedAtSelection) {
    setFeedAtSelection(feedKey)
    anchor.current = null
    if (selected.size > 0) setSelected(new Set())
  }

  // Escape is the universal "never mind" — the keyboard twin of the bar's ×. Bound
  // only while a selection exists, so it can't shadow a dialog's own Escape at rest.
  useEffect(() => {
    if (selected.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected.size, clear])

  const toggle = useCallback(
    (shortId: string, shift = false) => {
      setSelected((prev) => {
        const next = new Set(prev)
        const from = anchor.current
        // Shift extends from the anchor through this card (inclusive), additive — the
        // grid/list order IS the range, so a range never picks up an off-screen id.
        if (shift && from && from !== shortId) {
          const order = items.map((a) => a.short_id)
          const i = order.indexOf(from)
          const j = order.indexOf(shortId)
          if (i !== -1 && j !== -1) {
            for (const id of order.slice(Math.min(i, j), Math.max(i, j) + 1)) next.add(id)
            anchor.current = shortId
            return next
          }
        }
        if (next.has(shortId)) next.delete(shortId)
        else next.add(shortId)
        anchor.current = shortId
        return next
      })
    },
    [items],
  )

  // The selection as ARTIFACTS, in feed order. Deriving from `items` (rather than
  // stashing the objects at click time) is what keeps a bulk write honest: an id whose
  // card has since left the feed — deleted, filtered out by a refetch — simply drops
  // out here, so the bar can never act on a row that isn't there any more.
  const selectedItems = useMemo(
    () => items.filter((a) => selected.has(a.short_id)),
    [items, selected],
  )

  return { selected, selectedItems, active: selected.size > 0, toggle, clear }
}

// What a card/row needs to render its checkbox, threaded through the grid + list views.
export interface LibrarySelection {
  selected: ReadonlySet<string>
  // Any selection in progress — every checkbox shows, not just the hovered card's.
  active: boolean
  toggle: (shortId: string, shift?: boolean) => void
}
