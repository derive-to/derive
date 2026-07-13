// Split `text` into segments, marking the ones that literally match `query`
// (case-insensitive). The pure basis for highlighting a search snippet — no regex is
// built from user input, and the original casing is preserved in the output.
export function splitMatches(text: string, query: string): { text: string; match: boolean }[] {
  const term = query.trim()
  if (!term) return text ? [{ text, match: false }] : []
  const lower = text.toLowerCase()
  const needle = term.toLowerCase()
  const out: { text: string; match: boolean }[] = []
  let from = 0
  let at = lower.indexOf(needle)
  while (at !== -1) {
    if (at > from) out.push({ text: text.slice(from, at), match: false })
    out.push({ text: text.slice(at, at + term.length), match: true })
    from = at + term.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false })
  return out
}
