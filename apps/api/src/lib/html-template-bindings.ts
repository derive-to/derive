/**
 * Library-entry HTML bindings are text-only: a `{{Name}}` placeholder inside a tag,
 * script, or style has no safe substitution (JS, CSS, unquoted attributes), so the
 * entry is refused rather than substituted ambiguously. Returns the offending names.
 */
export function unsafeHtmlTemplateBindings(
  source: string,
  inputs: readonly { name: string }[],
): string[] {
  const names = new Set(
    inputs.flatMap((input) => [
      input.name.toLowerCase(),
      input.name.replace(/\s+/g, "_").toLowerCase(),
      input.name.replace(/\s+/g, "-").toLowerCase(),
    ]),
  )
  const unsafe = new Set<string>()
  const scriptRanges = [...source.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].map(
    (match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const,
  )
  // Scanned by hand so malformed input ("{{{{    ") cannot trigger regex backtracking.
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor)
    if (start === -1) break
    cursor = start + 2

    let bindingStart = start
    while (cursor < source.length && !source.startsWith("}}", cursor)) {
      if (source.startsWith("{{", cursor)) {
        bindingStart = cursor
        cursor += 2
      } else {
        cursor += 1
      }
    }
    if (cursor >= source.length) break
    const end = cursor
    cursor = end + 2

    const binding = source.slice(bindingStart + 2, end)
    if (!binding || binding.includes("{") || binding.includes("}")) continue
    const name = binding.trim()
    if (!names.has(name.toLowerCase())) continue
    const inScriptOrStyle = scriptRanges.some(
      ([rangeStart, rangeEnd]) => bindingStart >= rangeStart && bindingStart < rangeEnd,
    )
    const inTag = source.lastIndexOf("<", bindingStart) > source.lastIndexOf(">", bindingStart)
    if (inScriptOrStyle || inTag) unsafe.add(name)
  }
  return [...unsafe]
}
