import { Check, ChevronDown } from "lucide-react"
import { Icon } from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "./types"

export type LibraryFilter = NonNullable<LibrarySearch["filter"]> | "all"

// Four ways to narrow the home library, in ONE control. Favorites and "Shared with you"
// were rail rows and "Created by me" was a tab, all pointing at the same list — four
// permanent slots spent on states most people are never in. A menu costs one, and unlike
// the routes it composes with where you already are: `Mine` inside a collection means your
// documents in that collection.
//
// Deliberately a menu and not a segmented control: the default is the answer almost every
// time, so the other three should cost a click to reach and nothing to ignore.
const OPTIONS: { value: LibraryFilter; label: string; hint: string }[] = [
  { value: "all", label: "All artifacts", hint: "Everything you can see here" },
  { value: "needs-you", label: "Needs you", hint: "Open threads you're in" },
  { value: "mine", label: "Mine", hint: "Artifacts you created" },
  { value: "shared", label: "Shared with me", hint: "Shared with you directly" },
  { value: "starred", label: "Starred", hint: "Artifacts you starred" },
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
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs outline-none transition-colors duration-state",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            // At rest it reads as optional, because it is: a dashed chip that says
            // "+ Filter". A chosen facet fills quietly — the label carries which one.
            value === "all"
              ? "border border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              : "border border-border bg-accent font-medium text-foreground",
          )}
        >
          {value === "all" ? (
            <>
              <Icon name="plus" size={12} aria-hidden /> Filter
            </>
          ) : (
            filterLabel(value)
          )}
          {needsYou > 0 && value !== "needs-you" && (
            <span
              data-testid="library-filter-needsyou-count"
              title={`${needsYou} waiting on you`}
              className="rounded-full bg-primary/10 px-1.5 font-mono text-2xs text-primary tabular-nums"
            >
              {needsYou}
            </span>
          )}
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
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
