// Local title matching for the ⌘K palette: rank the artifacts already in the query
// cache against a typed query, so the common case — finding your own document by
// name — paints on the keystroke instead of after a server round trip. Pure and
// deliberately simple: exact-ish tiers beat a clever distance metric for titles,
// and the server's search stays the authority a beat later.

export type TitledRow = { short_id: string; title?: string | null; updated_at?: string | null }

// Rank tiers: prefix > word-boundary prefix > substring > in-order subsequence.
// Within a tier, more recently updated wins (matches the library's own order).
const scoreTitle = (title: string, q: string): number => {
  const t = title.toLowerCase()
  if (t.startsWith(q)) return 4
  if (t.split(/[\s\-_/:]+/).some((w) => w.startsWith(q))) return 3
  if (t.includes(q)) return 2
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

export const fuzzyTitles = <T extends TitledRow>(rows: T[], query: string, limit = 8): T[] => {
  const q = query.trim().toLowerCase()
  const seen = new Set<string>()
  const unique = rows.filter((r) => {
    if (!r.title || seen.has(r.short_id)) return false
    seen.add(r.short_id)
    return true
  })
  if (!q) {
    // Empty query = the palette's "recent" strip: newest first, straight from cache.
    return unique
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, limit)
  }
  return unique
    .map((r) => ({ r, s: scoreTitle(r.title ?? "", q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.r.updated_at ?? "").localeCompare(a.r.updated_at ?? ""))
    .slice(0, limit)
    .map((x) => x.r)
}
