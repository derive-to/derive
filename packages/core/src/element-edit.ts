/**
 * Source-safe edits to a rendered element.
 *
 * Inline text edits locate visible words, then splice their exact source span. A
 * resize has no visible text to quote, so it rides the same ElementSelector used by
 * comments. The selector is resolved against the exact base version and only the
 * matching opening tag is changed; the document is never DOM-serialized.
 */

import { EditError } from "./doc-text"
import {
  type ElementDescriptor,
  type ElementSelector,
  fingerprintOf,
  parseElementSelector,
  resolveElement,
  scanElements,
} from "./element-anchor"

export interface ElementResizeEdit {
  op: "resize"
  target: ElementSelector
  /** Rendered CSS pixels. Kept bounded so a hostile payload cannot create absurd CSS. */
  width: number
  /** Images/media preserve their aspect ratio with `auto`; boxes carry a pixel height. */
  height: number | "auto"
}

export type ElementEdit = ElementResizeEdit

const MIN_SIZE = 24
const MAX_SIZE = 8192
const MAX_ELEMENT_EDITS = 200

export const isElementEdit = (value: unknown): value is ElementEdit => {
  if (!value || typeof value !== "object") return false
  const e = value as Partial<ElementResizeEdit>
  return e.op === "resize" && !!e.target && typeof e.target === "object"
}

const selectorOf = (raw: unknown, label: string): ElementSelector => {
  let json = ""
  try {
    json = JSON.stringify(raw)
  } catch {
    throw new EditError(`${label} failed: its element selector isn't valid JSON.`)
  }
  const selector = parseElementSelector(json)
  if (!selector) throw new EditError(`${label} failed: its element selector is malformed.`)
  return selector
}

const sizeOf = (raw: unknown, name: "width" | "height", label: string): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw))
    throw new EditError(`${label} failed: ${name} must be a whole number of pixels.`)
  if (raw < MIN_SIZE || raw > MAX_SIZE)
    throw new EditError(
      `${label} failed: ${name} must be between ${MIN_SIZE} and ${MAX_SIZE} pixels.`,
    )
  return raw
}

/**
 * Write resolution is deliberately stricter than comment relocation. This edit is
 * based on the current version, so an unchanged element must still agree on its
 * same-tag ordinal AND content (or authored id). Only then do we fall back to the
 * relocation cascade, and never to a low-confidence guess.
 */
const editTarget = (
  selector: ElementSelector,
  descriptors: ElementDescriptor[],
  label: string,
): ElementDescriptor => {
  const atOrdinal = descriptors.find(
    (d) => d.tag === selector.tag && d.ordinal === selector.ordinal,
  )
  if (
    atOrdinal &&
    (fingerprintOf(atOrdinal) === selector.fingerprint ||
      (!!selector.id && atOrdinal.id === selector.id))
  )
    return atOrdinal

  const match = resolveElement(selector, descriptors)
  const target = match ? descriptors[match.index] : undefined
  const strong = match?.signals.includes("id") || match?.signals.includes("content")
  if (!target || match?.band === "low" || !strong)
    throw new EditError(
      `${label} failed: that element couldn't be matched confidently in the stored source. Open the source editor instead.`,
    )
  return target
}

/** Split a style attribute at real declaration boundaries (not semicolons inside
 * strings, data URLs, or functions). Existing declaration values stay intact. */
const declarations = (style: string): string[] => {
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

const resizedStyle = (style: string, width: number, height: number | "auto"): string => {
  const kept = declarations(style).filter((d) => {
    const property = propertyOf(d)
    return d.trim() && property !== "width" && property !== "height"
  })
  kept.push(`width: ${width}px`, `height: ${height === "auto" ? "auto" : `${height}px`}`)
  return kept.map((d) => d.trim()).join("; ")
}

/** Change/add only the opening tag's style attribute, preserving quote style and
 * every unrelated attribute. */
const resizeOpeningTag = (tag: string, width: number, height: number | "auto"): string => {
  const style = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
  if (style) {
    const raw = style[2] ?? style[3] ?? style[4] ?? ""
    const quote = style[2] !== undefined ? '"' : style[3] !== undefined ? "'" : '"'
    const replacement = `${style[1]}${quote}${resizedStyle(raw, width, height)}${quote}`
    return tag.slice(0, style.index) + replacement + tag.slice(style.index + style[0].length)
  }
  const close = tag.lastIndexOf(">")
  if (close < 0) return tag
  let insert = close
  for (let i = close - 1; i >= 0 && /\s/.test(tag[i] as string); i--) insert = i
  if (tag[insert - 1] === "/") insert--
  const attr = ` style="${resizedStyle("", width, height)}"`
  return tag.slice(0, insert) + attr + tag.slice(insert)
}

/** Apply element edits in order. Each op sees the preceding op, matching exact-text
 * edit semantics; the whole call still throws before publishing if any op fails. */
export function applyElementEdits(html: string, edits: ElementEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0)
    throw new EditError("`edits` contains no element operations.")
  if (edits.length > MAX_ELEMENT_EDITS)
    throw new EditError(
      `Element edits has ${edits.length} entries — the maximum per request is ${MAX_ELEMENT_EDITS}.`,
    )

  let out = html
  for (const [i, raw] of edits.entries()) {
    const label = `Element edit ${i + 1} of ${edits.length}`
    if (raw?.op !== "resize")
      throw new EditError(`${label} failed: unknown operation ${JSON.stringify(raw?.op)}.`)
    const selector = selectorOf(raw.target, label)
    const width = sizeOf(raw.width, "width", label)
    const height = raw.height === "auto" ? "auto" : sizeOf(raw.height, "height", label)
    const descriptors = scanElements(out)
    const target = editTarget(selector, descriptors, label)
    const opening = out.slice(target.sourceStart, target.sourceEnd)
    const resized = resizeOpeningTag(opening, width, height)
    if (resized === opening)
      throw new EditError(`${label} leaves that element at its existing size.`)
    out = out.slice(0, target.sourceStart) + resized + out.slice(target.sourceEnd)
  }
  return out
}
