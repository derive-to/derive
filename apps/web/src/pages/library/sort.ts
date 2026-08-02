import type { SortMode } from "@derive/core"

// Runtime mirror of @derive/core's sort mode list — the SPA imports the TYPE only (it never
// pulls core's runtime bundle in; same boundary as api.ts). Values MUST match core/src/sort.ts;
// the `SortMode` type keeps them honest at compile time.
export const DEFAULT_SORT: SortMode = "updated"

// Three, each naming what it orders by. The menu used to offer six, and two of them —
// "Newest" (`updated`) and "Recently updated" (`revised`) — were indistinguishable from
// their labels: both order on last-activity time, and `revised` only differs by floating
// docs with a second version above the rest. Nobody could predict which they were picking,
// so `revised` is out of the menu. It stays a valid `?sort=` value on the API, which is a
// wire contract, not a UI affordance.
//
// `created` was always a valid core mode and simply was not offered; it is the honest
// "Recently created", distinct from last activity in the way people expect.
export const LIBRARY_SORTS: { value: SortMode; label: string }[] = [
  { value: "updated", label: "Recently active" },
  { value: "created", label: "Recently created" },
  { value: "az", label: "Title A–Z" },
]

// The URL accepts the menu's three modes PLUS each direction's reverse — the list
// header's click-again-to-flip writes `za` / `updated-asc`, and a parser that only knew
// the menu list silently reset the sort to default on the very next route parse.
const REVERSED: SortMode[] = ["za", "updated-asc"]
const VALUES = new Set<string>([...LIBRARY_SORTS.map((s) => s.value), ...REVERSED])

/** Parse a URL sort value: a valid NON-default mode passes through; the default (and anything
 *  invalid) returns undefined so it's omitted from the URL — clean default links. */
export const parseLibrarySort = (raw: unknown): SortMode | undefined =>
  typeof raw === "string" && VALUES.has(raw) && raw !== DEFAULT_SORT ? (raw as SortMode) : undefined

/** The menu label for a mode (falls back to the default's label for a value the menu no
 *  longer lists — e.g. `revised`, or a stale `?sort=` from an old bookmark). */
export const sortLabel = (mode: SortMode): string =>
  LIBRARY_SORTS.find((s) => s.value === mode)?.label ??
  (mode === "za"
    ? "Title Z–A"
    : mode === "updated-asc"
      ? "Least recently active"
      : "Recently active")
