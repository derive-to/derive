import type { TemplateInput } from "./types"

/**
 * Beta HTML bindings are deliberately text-only. Refusing placeholders inside
 * tags, scripts, and styles avoids ambiguous JS/CSS/unquoted-attribute contexts
 * while still supporting rich authored pages and decks byte-for-byte.
 */
export function unsafeHtmlTemplateBindings(
  source: string,
  inputs: readonly TemplateInput[],
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
  // Scan delimiters directly so malformed input cannot trigger regex
  // backtracking on whitespace-heavy sequences such as "{{{{    ".
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
