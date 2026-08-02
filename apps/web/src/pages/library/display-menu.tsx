import type { SortMode } from "@derive/core"
import { SlidersHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LIBRARY_SORTS } from "./sort"

// The library's one "how is this list shown" control — order, and (in an organized
// collection) whether to group by folder. Consolidated into a single "Display" menu so
// the two knobs live in one place and their interaction is legible (folders are always
// alphabetical; the sort orders the cards WITHIN each folder) — instead of a sort menu in
// the toolbar and a stray grouping toggle floating over the grid. Built on the dropdown
// system (non-modal, composes inside dialogs) like SortMenu was.
export function DisplayMenu({
  layout,
  onLayout,
  sort,
  onSort,
  group,
}: {
  /** Omitted in the Collections view: shelves have one order, and the grouped list
   *  sorts from its own column headers. */
  sort?: SortMode
  onSort?: (mode: SortMode) => void
  // Present only where grouping is possible (a manual collection with folders).
  group?: { on: boolean; onChange: (on: boolean) => void }
  layout: "grid" | "list"
  onLayout: (next: "grid" | "list") => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="library-display"
          aria-label="Display options"
          className="flex h-8 w-fit items-center gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2.5 pl-2.5 text-sm whitespace-nowrap shadow-(--shadow-sm) outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        >
          <SlidersHorizontal />
          Display
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={layout}
          onValueChange={(v) => onLayout(v as "grid" | "list")}
        >
          <DropdownMenuRadioItem value="grid" className="py-1.5 pr-8 pl-2">
            Grid
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="list" className="py-1.5 pr-8 pl-2">
            List
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {sort && onSort && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSort(v as SortMode)}>
              {LIBRARY_SORTS.map((s) => (
                <DropdownMenuRadioItem key={s.value} value={s.value} className="py-1.5 pr-8 pl-2">
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {group && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={group.on}
              // Radix fires onSelect→close by default; keep the menu open so the grid
              // regroups under the cursor and a second toggle is one click away.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={group.onChange}
              data-testid="collection-group-toggle"
            >
              Group by folder
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
