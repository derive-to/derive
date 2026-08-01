import { Check, ChevronDown } from "lucide-react"
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
  { value: "all", label: "All documents", hint: "Everything you can see here" },
  { value: "mine", label: "Mine", hint: "Documents you created" },
  { value: "shared", label: "Shared with me", hint: "Shared with you directly" },
  { value: "starred", label: "Starred", hint: "Documents you starred" },
]

const filterLabel = (f: LibraryFilter): string =>
  OPTIONS.find((o) => o.value === f)?.label ?? "All documents"

export function FilterMenu({
  value,
  onChange,
}: {
  value: LibraryFilter
  onChange: (next: LibraryFilter) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="library-filter"
          aria-label={`Filter: ${filterLabel(value)}`}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium outline-none",
            "hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            // Non-default reads as active state — a neutral wash, never a tint (the
            // ink-deployment rule): the label already says which filter is on.
            value === "all" ? "text-muted-foreground" : "bg-accent text-foreground",
          )}
        >
          {filterLabel(value)}
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
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
