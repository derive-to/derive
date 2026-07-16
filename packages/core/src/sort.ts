/**
 * Library sort modes: the orderings the artifact list can be viewed in, shared by the API
 * (the `?sort=` query param) and the store (ORDER BY + keyset cursor). Pure — no I/O — so it
 * is unit-tested and both DB backends derive their ordering from ONE definition and can't
 * drift. The web app mirrors the value list + labels (it never pulls core's runtime in) and
 * imports only the `SortMode` type; see apps/web/src/pages/library/sort.ts.
 */

export type SortMode = "updated" | "updated-asc" | "created" | "created-asc" | "az" | "za"

/** The default the library opens in: newest first, where "newest" tracks a doc's LAST
 *  version — publishing a new version bumps it back to the top. Only the two `created` modes
 *  ignore versions. */
export const DEFAULT_SORT: SortMode = "updated"

/** Every mode, in the order the menu offers them. */
export const SORT_MODES: readonly SortMode[] = [
  "updated",
  "updated-asc",
  "created",
  "created-asc",
  "az",
  "za",
]

/** Validate a raw query value; anything unknown or absent falls back to the default, so a
 *  hand-typed or stale `?sort=` never errors or wedges the list. */
export const parseSortMode = (raw: string | null | undefined): SortMode =>
  raw != null && (SORT_MODES as readonly string[]).includes(raw) ? (raw as SortMode) : DEFAULT_SORT

/** The keyset field + direction a mode orders by. The store maps `field` to a column
 *  expression and applies `dir` to BOTH the ORDER BY and the cursor comparison, so a mode's
 *  ordering and its pagination can't disagree. */
export const sortFields = (
  mode: SortMode,
): { field: "updated" | "created" | "title"; dir: "asc" | "desc" } => {
  switch (mode) {
    case "updated":
      return { field: "updated", dir: "desc" }
    case "updated-asc":
      return { field: "updated", dir: "asc" }
    case "created":
      return { field: "created", dir: "desc" }
    case "created-asc":
      return { field: "created", dir: "asc" }
    case "az":
      return { field: "title", dir: "asc" }
    case "za":
      return { field: "title", dir: "desc" }
  }
}

/** The value the keyset cursor carries for a row under `mode` — the JS twin of the store's
 *  ordering expression, for building the next-page cursor. `updated` coalesces to created_at
 *  (a row is versionless until its first publish); `title` is the RAW title (coalesced to '').
 *  The store lowers BOTH the column and the cursor key in SQL (`lower(coalesce(title,''))`),
 *  so the SAME engine owns case-folding for the comparison — JS `toLowerCase()` (full Unicode)
 *  and SQLite's `lower()` (ASCII-only on D1/SQLite) disagree on non-ASCII letters, which would
 *  corrupt a title-sort page boundary if JS lowered the key instead. */
export const sortKeyOf = (
  row: { created_at: string; updated_at: string | null; title: string | null },
  mode: SortMode,
): string => {
  const { field } = sortFields(mode)
  if (field === "updated") return row.updated_at ?? row.created_at
  if (field === "title") return row.title ?? ""
  return row.created_at
}

/** Keyset cursor codec: an opaque "<key>|<id>" string. An id is delimiter-free, so decode
 *  splits on the LAST '|' — a title key can itself contain '|', which a first-'|' split would
 *  silently corrupt. An empty key (a null-title row under az) is valid: a leading '|' with a
 *  non-empty id. */
export const encodeCursor = (key: string, id: string): string => `${key}|${id}`

export const decodeCursor = (
  raw: string | null | undefined,
): { key: string; id: string } | undefined => {
  if (!raw) return undefined
  const sep = raw.lastIndexOf("|")
  if (sep < 0 || sep === raw.length - 1) return undefined
  return { key: raw.slice(0, sep), id: raw.slice(sep + 1) }
}
