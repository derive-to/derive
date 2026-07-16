import type { SortMode } from "@derive/core"

// Runtime mirror of @derive/core's sort mode list — the SPA imports the TYPE only (it never
// pulls core's runtime bundle in; same boundary as api.ts). Values MUST match core/src/sort.ts;
// the `SortMode` type keeps them honest at compile time.
export const DEFAULT_SORT: SortMode = "updated"

export const LIBRARY_SORTS: { value: SortMode; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "updated-asc", label: "Least recently updated" },
  { value: "created", label: "Recently created" },
  { value: "created-asc", label: "Oldest created" },
  { value: "az", label: "Title A–Z" },
  { value: "za", label: "Title Z–A" },
]

const VALUES = new Set<string>(LIBRARY_SORTS.map((s) => s.value))

/** Parse a URL sort value: a valid NON-default mode passes through; the default (and anything
 *  invalid) returns undefined so it's omitted from the URL — clean default links. */
export const parseLibrarySort = (raw: unknown): SortMode | undefined =>
  typeof raw === "string" && VALUES.has(raw) && raw !== DEFAULT_SORT ? (raw as SortMode) : undefined

/** The menu label for a mode (falls back to the default's label for an unknown value). */
export const sortLabel = (mode: SortMode): string =>
  LIBRARY_SORTS.find((s) => s.value === mode)?.label ?? "Recently updated"
