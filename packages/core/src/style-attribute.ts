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
  return colon < 0 ? "" : declaration.slice(0, colon).trim().toLowerCase()
}

export const stylePropertyValues = (style: string, property: string): string[] => {
  const wanted = property.trim().toLowerCase()
  return styleDeclarations(style).flatMap((declaration) => {
    if (propertyOf(declaration) !== wanted) return []
    const colon = declaration.indexOf(":")
    return colon < 0 ? [] : [declaration.slice(colon + 1).trim()]
  })
}

export const updatedStyle = (
  style: string,
  changes: Readonly<Record<string, string | null>>,
): string => {
  const normalized = new Map(
    Object.entries(changes).map(([property, value]) => [property.trim().toLowerCase(), value]),
  )
  const kept = styleDeclarations(style).filter((declaration) => {
    const property = propertyOf(declaration)
    return declaration.trim() && !normalized.has(property)
  })
  for (const [property, value] of normalized) if (value !== null) kept.push(`${property}: ${value}`)
  return kept.map((declaration) => declaration.trim()).join("; ")
}

/** Change only requested properties in one opening tag's style attribute. Existing
 * quote style and unrelated declarations survive; an emptied style attribute is
 * removed so reset can restore the exact absence of editor-owned styling. */
export const updateOpeningTagStyle = (
  tag: string,
  changes: Readonly<Record<string, string | null>>,
): string => {
  const style = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
  if (style) {
    const raw = style[2] ?? style[3] ?? style[4] ?? ""
    const next = updatedStyle(raw, changes)
    const quote = style[2] !== undefined ? '"' : style[3] !== undefined ? "'" : '"'
    const replacement = next ? `${style[1]}${quote}${next}${quote}` : ""
    return tag.slice(0, style.index) + replacement + tag.slice(style.index + style[0].length)
  }
  const additions = Object.entries(changes).filter((entry): entry is [string, string] => {
    const value = entry[1]
    return value !== null
  })
  if (!additions.length) return tag
  const close = tag.lastIndexOf(">")
  if (close < 0) return tag
  let insert = close
  for (let i = close - 1; i >= 0 && /\s/.test(tag[i] as string); i--) insert = i
  if (tag[insert - 1] === "/") insert--
  const value = additions.map(([property, next]) => `${property}: ${next}`).join("; ")
  return `${tag.slice(0, insert)} style="${value}"${tag.slice(insert)}`
}
