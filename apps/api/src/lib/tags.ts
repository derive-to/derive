// Browse tags are workspace-wide labels for finding artifacts later. One normalizer,
// shared by every write path (the single tag route, the bulk route, publish, and the MCP
// tools), so the stored vocabulary can never fragment on casing or whitespace: a tag typed
// "Q3 Planning", "q3 planning", and " Q3  Planning " must all land as the same "q3
// planning". Trimmed, lowercased, inner whitespace collapsed, deduped, capped per artifact,
// and sorted so every read returns them in one order.
export const MAX_TAGS_PER_ARTIFACT = 20
const MAX_TAG_LEN = 40

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== "string") continue
    const v = t.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN)
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= MAX_TAGS_PER_ARTIFACT) break
  }
  // Sorted so the PUT response matches the list/detail order (tagsForArtifacts also
  // sorts), and browse chips read alphabetically everywhere.
  return out.sort()
}

// Parse a `tags` field off a multipart/form body (the publish path): either a JSON array
// string (["a","b"]) or a comma/space-separated list ("a, b c"). Returns raw strings for
// normalizeTags to finish. Undefined field → null (leave tags untouched), an EMPTY string
// → [] (an explicit "clear the tags"), so a caller can distinguish "don't touch" from
// "remove all".
export function parseTagsField(field: unknown): string[] | null {
  if (typeof field !== "string") return null
  const s = field.trim()
  if (s === "") return []
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s)
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      // fall through to the delimiter split — a malformed JSON array is treated as text
    }
  }
  return s.split(/[,\n]/).flatMap((part) => part.trim().split(/\s+/))
}
