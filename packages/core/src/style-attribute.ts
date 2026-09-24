/** Split inline CSS at real declaration boundaries, not semicolons inside strings,
 * data URLs, or functions. Callers can then update editor-owned properties without
 * disturbing unrelated authored declarations. */
export const styleDeclarations = (style: string): string[] => {
  const out: string[] = []
  let start = 0
  let quote = ""
  let depth = 0
  let escaped = false
  for (let i = 0; i < style.length; i++) {
    const ch = style[i] as string
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "(") depth++
    else if (ch === ")" && depth > 0) depth--
    else if (ch === ";" && depth === 0) {
      out.push(style.slice(start, i))
      start = i + 1
    }
  }
  out.push(style.slice(start))
  return out
}

const propertyOf = (declaration: string): string => {
  const colon = declaration.indexOf(":")
  return colon < 0 ? "" : declaration.slice(0, colon).trim()
}

// Ordinary CSS properties are ASCII case-insensitive. Custom properties are not:
// `--Foo` and `--foo` are distinct variables and must never alias in source edits.
const normalizedProperty = (property: string): string =>
  property.startsWith("--") ? property : property.toLowerCase()

export const stylePropertyValues = (style: string, property: string): string[] => {
  const wanted = normalizedProperty(property.trim())
  return styleDeclarations(style).flatMap((declaration) => {
    if (normalizedProperty(propertyOf(declaration)) !== wanted) return []
    const colon = declaration.indexOf(":")
    return colon < 0 ? [] : [declaration.slice(colon + 1).trim()]
  })
}

export const updatedStyle = (
  style: string,
  changes: Readonly<Record<string, string | null>>,
): string => {
  const normalized = new Map(
    Object.entries(changes).map(([property, value]) => [
      normalizedProperty(property.trim()),
      value,
    ]),
  )
  const kept = styleDeclarations(style).filter((declaration) => {
    const property = normalizedProperty(propertyOf(declaration))
    return declaration.trim() && !normalized.has(property)
  })
  for (const [property, value] of normalized) if (value !== null) kept.push(`${property}: ${value}`)
  return kept.map((declaration) => declaration.trim()).join("; ")
}

const STYLE_ATTRIBUTE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const styleValueOf = (m: RegExpExecArray): string => m[2] ?? m[3] ?? m[4] ?? ""

/** Change only requested properties in one opening tag's style attribute. Existing
 * quote style and unrelated declarations survive; an emptied style attribute is
 * removed so reset can restore the exact absence of editor-owned styling. */
export const updateOpeningTagStyle = (
  tag: string,
  changes: Readonly<Record<string, string | null>>,
): string => {
  const current = STYLE_ATTRIBUTE.exec(tag)
  if (current) return setOpeningTagStyle(tag, updatedStyle(styleValueOf(current), changes) || null)
  const additions = Object.entries(changes).flatMap(([property, next]) =>
    next === null ? [] : [`${property}: ${next}`],
  )
  return setOpeningTagStyle(tag, additions.join("; ") || null)
}

/** Replace one opening tag's whole style attribute value (raw attribute text; the caller
 * escapes it), or remove the attribute when `value` is null or empty. The existing quote
 * style and every other attribute stay byte-identical. */
export const setOpeningTagStyle = (tag: string, value: string | null): string => {
  const style = STYLE_ATTRIBUTE.exec(tag)
  if (style) {
    const quote = style[3] !== undefined ? "'" : '"'
    const replacement = value ? `${style[1]}${quote}${value}${quote}` : ""
    return tag.slice(0, style.index) + replacement + tag.slice(style.index + style[0].length)
  }
  if (!value) return tag
  const close = tag.lastIndexOf(">")
  if (close < 0) return tag
  let insert = close
  for (let i = close - 1; i >= 0 && /\s/.test(tag[i] as string); i--) insert = i
  if (tag[insert - 1] === "/") insert--
  return `${tag.slice(0, insert)} style="${value}"${tag.slice(insert)}`
}
