import { Check, ListFilter } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "./types"

export type LibraryFilter = NonNullable<LibrarySearch["filter"]> | "all" | "archived"

// Ways to narrow the library live in one control. Favorites and "Shared with you" were
// rail rows, "Created by me" was a tab, and Archived was a permanent sidebar destination.
// None is a separate product surface. The active-artifact facets compose with the current
// collection; Archived opens its own server-backed shelf through the same control.
//
// Deliberately a menu and not a segmented control: the default is the answer almost every
// time, so the alternatives should cost a click to reach and nothing to ignore.
const OPTIONS: { value: LibraryFilter; label: string; hint: string }[] = [
  { value: "all", label: "All artifacts", hint: "Everything you can see here" },
  { value: "needs-you", label: "Needs you", hint: "Open threads you're in" },
  { value: "mine", label: "Mine", hint: "Artifacts you created" },
  { value: "shared", label: "Shared with me", hint: "Shared with you directly" },
  { value: "starred", label: "Starred", hint: "Artifacts you starred" },
  { value: "archived", label: "Archived", hint: "Put away without deleting" },
]

const filterLabel = (f: LibraryFilter): string =>
  OPTIONS.find((o) => o.value === f)?.label ?? "All artifacts"

export function FilterMenu({
  value,
  onChange,
  needsYou = 0,
}: {
  value: LibraryFilter
  onChange: (next: LibraryFilter) => void
  /** How many artifacts are waiting on you. Shown on the trigger, because it is the one
   *  thing here you might not already know — the rest are ways to slice a list you can
   *  see. This replaced a full-width banner above the grid. */
  needsYou?: number
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="library-filter"
          aria-label={`Filter: ${filterLabel(value)}`}
          className={cn(
            // Display's sibling, exactly: same height, same register, same quiet hover —
            // they are one kind of control ("how am I looking at this list") and sit
            // side by side on the view row. The dashed mini-chip this replaces put a
            // second visual idiom, at a second size, on a second level.
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors duration-state",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            value === "all"
              ? "text-muted-foreground hover:bg-accent hover:text-foreground"
              : "bg-accent font-medium text-foreground",
          )}
        >
          <ListFilter className="size-3.5" aria-hidden />
          {value === "all" ? "Filter" : filterLabel(value)}
          {needsYou > 0 && value !== "needs-you" && (
            <span
              data-testid="library-filter-needsyou-count"
              title={`${needsYou} waiting on you`}
              className="rounded-full bg-primary/10 px-1.5 font-mono text-2xs text-primary tabular-nums"
            >
              {needsYou}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.value}
            data-testid={`library-filter-${o.value}`}
            onSelect={() => onChange(o.value)}
            className="gap-2 py-1.5"
          >
            <span className="grid w-3.5 shrink-0 place-items-center">
              {o.value === value && <Check className="size-3.5" aria-hidden />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{o.label}</span>
              <span className="truncate text-2xs text-muted-foreground">{o.hint}</span>
            </span>
            {o.value === "needs-you" && needsYou > 0 && (
              <span className="ml-auto font-mono text-2xs text-primary tabular-nums">
                {needsYou}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
