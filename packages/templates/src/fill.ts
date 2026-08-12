import type { TemplateFormat, TemplateInput } from "./types"

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const escapeHtmlText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

/** Fill explicit {{name}} text bindings while preserving every other source byte. */
export function fillTemplateSource(
  source: string,
  inputs: readonly TemplateInput[],
  values: Readonly<Record<string, string>>,
  format: TemplateFormat,
): string {
  return inputs.reduce((next, input) => {
    const raw = values[input.name]?.trim()
    if (!raw) return next
    const value = format === "html" ? escapeHtmlText(raw) : raw
    const spellings = [input.name, input.name.replace(/\s+/g, "_"), input.name.replace(/\s+/g, "-")]
    return spellings.reduce(
      (text, name) =>
        text.replace(new RegExp(`\\{\\{\\s*${escapeRegex(name)}\\s*\\}\\}`, "gi"), () => value),
      next,
    )
  }, source)
}

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
  for (const match of source.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const name = match[1]?.trim() ?? ""
    if (!names.has(name.toLowerCase())) continue
    const at = match.index ?? 0
    const inScriptOrStyle = scriptRanges.some(([start, end]) => at >= start && at < end)
    const inTag = source.lastIndexOf("<", at) > source.lastIndexOf(">", at)
    if (inScriptOrStyle || inTag) unsafe.add(name)
  }
  return [...unsafe]
}
