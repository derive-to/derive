import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// The artifact card-grid geometry, defined once so the live grid, the virtualized
// grid, and the skeleton can't drift apart — shared by the library feed AND the
// profile Work grid (which is why it lives in shared/, not under one feature):
// 260px-floor cards (a preview-forward gallery — big enough to read the render) on a
// 16px column gutter, with a wider 24px vertical rhythm so captions get air before
// the next row's preview.
//
// `min(100%, 260px)` is the overflow-safe floor: on a container narrower than one
// card it drops to a single full-width column instead of forcing a scrollbar.
// `auto-fill` (not `auto-fit`) so a short last row keeps its natural card width
// rather than stretching a lone card full-bleed. MIN_CARD_PX mirrors the floor for
// the virtualizer's JS column math (it must match the CSS column count exactly).
export const MIN_CARD_PX = 260
export const CARD_GRID_COLS = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]"

export function CardGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(CARD_GRID_COLS, "gap-x-4 gap-y-6", className)}>{children}</div>
}
