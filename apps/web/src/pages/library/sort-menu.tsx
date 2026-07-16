import type { SortMode } from "@derive/core"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"
import { LIBRARY_SORTS, sortLabel } from "./sort"

// The library's order control. A radio SelectMenu (composes cleanly outside/inside dialogs,
// see select-menu.tsx) over the six modes; the page owns the URL write.
export function SortMenu({
  value,
  onChange,
}: {
  value: SortMode
  onChange: (mode: SortMode) => void
}) {
  return (
    <SelectMenu value={value} onValueChange={(v) => onChange(v as SortMode)}>
      <SelectMenuTrigger data-testid="library-sort" aria-label="Sort artifacts">
        {sortLabel(value)}
      </SelectMenuTrigger>
      <SelectMenuContent align="end">
        {LIBRARY_SORTS.map((s) => (
          <SelectMenuItem key={s.value} value={s.value}>
            {s.label}
          </SelectMenuItem>
        ))}
      </SelectMenuContent>
    </SelectMenu>
  )
}
