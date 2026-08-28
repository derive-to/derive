/**
 * Source-safe structural edits for explicitly authored regions.
 *
 * Structural editing is intentionally opt-in. Only direct children with stable
 * `data-derive-node` identities inside a `data-derive-region` whose layout is
 * `stack` can be changed. Every operation edits the original source string; this
 * module never serializes a browser DOM.
 */

import { nextUnusedSlideId, sliceSlides } from "./decks"
import { EditError } from "./doc-text"
import { attrValues, type HtmlTag, hasAttr, tags } from "./html-tags"
import { injectArtifactRuntimeScripts } from "./shared-state-client"

export const STRUCTURAL_EDIT_SCHEMA = "derive.structural-edit/v1" as const
export const STRUCTURAL_RECEIPT_SCHEMA = "derive.structural-edit-receipt/v1" as const

export type StructuralSize = "compact" | "standard" | "full"

interface StructuralEditBase {
  schema: typeof STRUCTURAL_EDIT_SCHEMA
  region: string
}

export interface StructuralSizeEdit extends StructuralEditBase {
  op: "structural-size"
  node: string
  size: StructuralSize | null
}

export interface StructuralOrderEdit extends StructuralEditBase {
  op: "structural-order"
  /** The complete desired order of every node currently in the region. */
  nodes: string[]
}

export interface StructuralRemoveEdit extends StructuralEditBase {
  op: "structural-remove"
  node: string
}

/** Internal inverse emitted in receipts. Clients normally send remove, not restore. */
export interface StructuralRestoreEdit extends StructuralEditBase {
  op: "structural-restore"
  node: string
  html: string
  before: string | null
  after: string | null
}

/** Internal byte-exact inverse for a semantic opening-tag mutation. */
export interface StructuralOpeningRestoreEdit extends StructuralEditBase {
  op: "structural-restore-opening"
  node: string
  opening: string
}

export type StructuralUserEdit = StructuralSizeEdit | StructuralOrderEdit | StructuralRemoveEdit

export type StructuralEdit =
  | StructuralUserEdit
  | StructuralRestoreEdit
  | StructuralOpeningRestoreEdit

export interface StructuralEditReceipt {
  schema: typeof STRUCTURAL_RECEIPT_SCHEMA
  inverses: StructuralEdit[]
}

export interface StructuralEditResult {
  html: string
  receipt: StructuralEditReceipt
}

export interface StructuralNodeInspection {
  id: string
  kind: string | null
  size: StructuralSize | null
}

export interface StructuralRegionInspection {
  id: string
  layout: "stack"
  nodes: StructuralNodeInspection[]
}

export interface StructuralBackfillSkip {
  slide: number
  reason:
    | "empty"
    | "runtime-child"
    | "browser-context-child"
    | "non-html-child"
    | "unowned-content"
    | "implicit-close"
}

export interface StructuralBackfillResult {
  html: string
  changed: boolean
  regions: number
  nodes: number
  skipped: StructuralBackfillSkip[]
}

export class StructuralEditError extends EditError {
  readonly code:
    | "invalid-operation"
    | "invalid-structure"
    | "missing-target"
    | "ambiguous-target"
    | "no-change"

  constructor(code: StructuralEditError["code"], message: string) {
    super(message)
    this.name = "StructuralEditError"
    this.code = code
  }
}

const MAX_STRUCTURAL_EDITS = 200
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const SIZES = new Set<StructuralSize>(["compact", "standard", "full"])
const STRUCTURAL_ATTRIBUTES = [
  "data-derive-region",
  "data-derive-layout",
  "data-derive-node",
  "data-derive-kind",
  "data-derive-size",
] as const

const fail = (code: StructuralEditError["code"], message: string): never => {
  throw new StructuralEditError(code, message)
}

const exactlyOne = (tag: HtmlTag, name: string, label: string): string | null => {
  const values = attrValues(tag.attrs, name)
  if (values.length > 1) fail("ambiguous-target", `${label} has more than one ${name} attribute.`)
  if (values.length === 0 && hasAttr(tag.attrs, name))
    fail("invalid-structure", `${label} has ${name} without a value.`)
  return values[0] ?? null
}

const identity = (value: string | null, label: string): string => {
  if (!value || !ID.test(value))
    fail(
      "invalid-structure",
      `${label} must be 1–128 characters and start with a letter; only letters, numbers, _ and - are allowed.`,
    )
  return value as string
}

interface SourceElement {
  tag: HtmlTag
  parentStart: number | null
  closeStart: number
  end: number
  explicitlyClosed: boolean
}

/** Build browser-effective element ranges and parentage while retaining whether a
 * declared element has a matching authored close token. */
const sourceElements = (html: string): SourceElement[] => {
  const all = tags(html)
  const closeFor = new Map<number, HtmlTag>()
  for (const tag of all) {
    if (!tag.closing) continue
    for (const start of tag.closedOpenStarts) closeFor.set(start, tag)
  }

  const elements: SourceElement[] = []
  for (const tag of all) {
    if (tag.closing) continue
    const close = closeFor.get(tag.start)
    const explicitlyClosed = tag.selfClosing || (!!close && close.name === tag.name)
    const end = tag.selfClosing ? tag.end : close?.name === tag.name ? close.end : -1
    const closeStart = tag.selfClosing ? tag.end : close?.name === tag.name ? close.start : -1
    elements.push({ tag, parentStart: null, closeStart, end, explicitlyClosed })
  }

  const stack: SourceElement[] = []
  for (const element of elements) {
    while ((stack.at(-1)?.end ?? Number.POSITIVE_INFINITY) <= element.tag.start) stack.pop()
    const parent = stack.at(-1)
    if (parent && parent.end >= element.end) element.parentStart = parent.tag.start
    if (!element.tag.selfClosing && element.end >= 0) stack.push(element)
  }
  return elements
}

interface OwnedNode extends StructuralNodeInspection {
  element: SourceElement
  /** End of this node's owned chunk, including its following whitespace/comments. */
  chunkEnd: number
}

interface OwnedRegion extends StructuralRegionInspection {
  element: SourceElement
  prefixEnd: number
  ownedNodes: OwnedNode[]
}

interface Inspection {
  regions: OwnedRegion[]
  byRegion: Map<string, OwnedRegion>
}

const htmlWhitespace = (code: number): boolean =>
  code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20

/** Accept only authored HTML comments and HTML whitespace between owned nodes.
 * This is a recognizer, not a sanitizer: it never rewrites or returns the gap. */
const ignorableGap = (source: string): boolean => {
  let cursor = 0
  while (cursor < source.length) {
    if (htmlWhitespace(source.charCodeAt(cursor))) {
      cursor++
      continue
    }
    if (!source.startsWith("<!--", cursor)) return false
    const commentEnd = source.indexOf("-->", cursor + 4)
    if (commentEnd < 0) return false
    cursor = commentEnd + 3
  }
  return true
}

const inspect = (html: string): Inspection => {
  const elements = sourceElements(html)
  const elementByStart = new Map(elements.map((element) => [element.tag.start, element]))
  const regionElements = elements.filter((element) =>
    hasAttr(element.tag.attrs, "data-derive-region"),
  )
  const nodeElements = elements.filter((element) => hasAttr(element.tag.attrs, "data-derive-node"))

  const byRegion = new Map<string, OwnedRegion>()
  const regionByStart = new Map<number, OwnedRegion>()
  for (const element of regionElements) {
    const id = identity(
      exactlyOne(element.tag, "data-derive-region", "A structural region"),
      "A structural region id",
    )
    if (byRegion.has(id)) fail("ambiguous-target", `Structural region ${id} is authored twice.`)
    if (hasAttr(element.tag.attrs, "data-derive-node"))
      fail("invalid-structure", `Structural region ${id} cannot also be a structural node.`)
    if (!element.explicitlyClosed || element.tag.selfClosing)
      fail("invalid-structure", `Structural region ${id} needs an explicit matching close tag.`)
    for (
      let ancestor =
        element.parentStart === null ? undefined : elementByStart.get(element.parentStart);
      ancestor;
      ancestor =
        ancestor.parentStart === null ? undefined : elementByStart.get(ancestor.parentStart)
    )
      if (hasAttr(ancestor.tag.attrs, "data-derive-node"))
        fail("invalid-structure", `Structural region ${id} cannot be nested inside a node.`)
    const layout = exactlyOne(element.tag, "data-derive-layout", `Structural region ${id}`)
    if (layout !== "stack")
      fail("invalid-structure", `Structural region ${id} must declare data-derive-layout="stack".`)
    const region: OwnedRegion = {
      id,
      layout: "stack",
      nodes: [],
      ownedNodes: [],
      element,
      prefixEnd: element.closeStart,
    }
    byRegion.set(id, region)
    regionByStart.set(element.tag.start, region)
  }

  const nodeIds = new Set<string>()
  for (const element of nodeElements) {
    const id = identity(
      exactlyOne(element.tag, "data-derive-node", "A structural node"),
      "A structural node id",
    )
    if (nodeIds.has(id)) fail("ambiguous-target", `Structural node ${id} is authored twice.`)
    if (hasAttr(element.tag.attrs, "data-derive-region"))
      fail("invalid-structure", `Structural node ${id} cannot also be a structural region.`)
    nodeIds.add(id)
    if (!element.explicitlyClosed)
      fail("invalid-structure", `Structural node ${id} needs an explicit matching close tag.`)
    const region = element.parentStart === null ? undefined : regionByStart.get(element.parentStart)
    if (!region)
      throw new StructuralEditError(
        "invalid-structure",
        `Structural node ${id} must be a direct child of a declared stack region.`,
      )
    const rawSize = exactlyOne(element.tag, "data-derive-size", `Structural node ${id}`)
    if (rawSize !== null && !SIZES.has(rawSize as StructuralSize))
      fail(
        "invalid-structure",
        `Structural node ${id} has unsupported size ${JSON.stringify(rawSize)}.`,
      )
    const node: OwnedNode = {
      id,
      kind: exactlyOne(element.tag, "data-derive-kind", `Structural node ${id}`),
      size: rawSize as StructuralSize | null,
      element,
      chunkEnd: element.end,
    }
    region.ownedNodes.push(node)
  }

  for (const region of byRegion.values()) {
    region.ownedNodes.sort((a, b) => a.element.tag.start - b.element.tag.start)
    let cursor = region.element.tag.end
    for (const [index, node] of region.ownedNodes.entries()) {
      const gap = html.slice(cursor, node.element.tag.start)
      if (!ignorableGap(gap))
        fail(
          "invalid-structure",
          `Structural region ${region.id} contains content outside its declared nodes.`,
        )
      if (index === 0) region.prefixEnd = node.element.tag.start
      const next = region.ownedNodes[index + 1]
      node.chunkEnd = next?.element.tag.start ?? region.element.closeStart
      cursor = node.element.end
    }
    if (!ignorableGap(html.slice(cursor, region.element.closeStart)))
      fail(
        "invalid-structure",
        `Structural region ${region.id} contains content outside its declared nodes.`,
      )
    region.nodes = region.ownedNodes.map(({ id, kind, size }) => ({ id, kind, size }))
  }

  return { regions: [...byRegion.values()], byRegion }
}

export const inspectStructuralDocument = (html: string): StructuralRegionInspection[] =>
  inspect(html).regions.map(({ id, layout, nodes }) => ({ id, layout, nodes }))

export const isStructuralEdit = (value: unknown): value is StructuralEdit => {
  if (!value || typeof value !== "object") return false
  const edit = value as Partial<StructuralEdit>
  return (
    edit.schema === STRUCTURAL_EDIT_SCHEMA &&
    (edit.op === "structural-size" ||
      edit.op === "structural-order" ||
      edit.op === "structural-remove" ||
      edit.op === "structural-restore" ||
      edit.op === "structural-restore-opening")
  )
}

/** Public edit surfaces accept intent only. The byte-carrying restore shapes are
 * receipt inverses and must never be accepted as client-authored input. */
export const isStructuralUserEdit = (value: unknown): value is StructuralUserEdit =>
  isStructuralEdit(value) &&
  (value.op === "structural-size" ||
    value.op === "structural-order" ||
    value.op === "structural-remove")

const regionFor = (inspection: Inspection, id: unknown, label: string): OwnedRegion => {
  if (typeof id !== "string" || !ID.test(id))
    fail("invalid-operation", `${label} has an invalid region id.`)
  const region = inspection.byRegion.get(id as string)
  if (!region)
    throw new StructuralEditError(
      "missing-target",
      `${label} could not find structural region ${id}.`,
    )
  return region
}

const nodeFor = (region: OwnedRegion, id: unknown, label: string): OwnedNode => {
  if (typeof id !== "string" || !ID.test(id))
    fail("invalid-operation", `${label} has an invalid node id.`)
  const matches = region.ownedNodes.filter((node) => node.id === id)
  if (!matches.length)
    fail("missing-target", `${label} could not find node ${id} in region ${region.id}.`)
  if (matches.length > 1)
    fail("ambiguous-target", `${label} found node ${id} more than once in region ${region.id}.`)
  const match = matches[0]
  if (!match)
    throw new StructuralEditError(
      "missing-target",
      `${label} could not find node ${String(id)} in region ${region.id}.`,
    )
  return match
}

/** Add, replace, or remove one opening-tag attribute without touching other bytes. */
const setAttribute = (opening: string, name: string, value: string | null): string => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(\\s+)${escaped}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i")
  const match = pattern.exec(opening)
  if (match) {
    if (value === null)
      return opening.slice(0, match.index) + opening.slice(match.index + match[0].length)
    const raw = match[0]
    const quote = raw.includes("'") && !raw.includes('"') ? "'" : '"'
    const replacement = `${match[1]}${name}=${quote}${value}${quote}`
    return opening.slice(0, match.index) + replacement + opening.slice(match.index + raw.length)
  }
  if (value === null) return opening
  const close = opening.lastIndexOf(">")
  if (close < 0) return opening
  let insert = close
  while (insert > 0 && /\s/.test(opening.charAt(insert - 1))) insert--
  if (opening[insert - 1] === "/") insert--
  return `${opening.slice(0, insert)} ${name}="${value}"${opening.slice(insert)}`
}

const BACKFILL_STYLE = `<style data-derive-structural-backfill>
[data-derive-region][data-derive-layout="stack"] > [data-derive-node][data-derive-size="compact"] { width: 50% !important; max-width: none !important; box-sizing: border-box !important }
[data-derive-region][data-derive-layout="stack"] > [data-derive-node][data-derive-size="standard"] { width: 75% !important; max-width: none !important; box-sizing: border-box !important }
[data-derive-region][data-derive-layout="stack"] > [data-derive-node][data-derive-size="full"] { width: 100% !important; max-width: none !important; box-sizing: border-box !important }
</style>`

const RUNTIME_CHILDREN = new Set([
  "base",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
])

// Browsers do not retain these as direct children of an ordinary slide. Table
// parts are discarded or foster-parented without a table; document roots merge
// into the surrounding document. Stamping their source token would advertise a
// node that the live interaction client can never find. Their valid containers
// (`table`, and ordinary HTML wrappers) remain safe atomic nodes.
const BROWSER_CONTEXT_CHILDREN = new Set([
  "body",
  "caption",
  "col",
  "colgroup",
  "frame",
  "frameset",
  "head",
  "html",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
])

const inferredKind = (name: string): string => {
  if (/^h[1-6]$/.test(name)) return "heading"
  if (name === "p" || name === "blockquote" || name === "pre") return "text"
  if (name === "ul" || name === "ol" || name === "dl") return "list"
  if (["img", "picture", "video", "canvas", "svg", "figure"].includes(name)) return "visual"
  if (["header", "footer", "nav", "aside"].includes(name)) return name
  return "group"
}

/**
 * Give legacy decks the same exact-source structural contract as newly authored
 * decks. This is deliberately a recognizer, not a visual-layout guess:
 *
 * - slide identity comes from the existing deck contract (or is deterministically
 *   stamped exactly as whole-slide rearranging already does);
 * - only explicit direct source children become nodes;
 * - meaningful loose text, implicit closes, and runtime-bearing children skip that
 *   slide instead of being moved under an invented owner;
 * - a document with any existing structural metadata is left entirely alone, so a
 *   partial authored contract is never silently completed with different intent.
 *
 * The pure transform is used both for the app render and for edit materialization.
 * That lets a legacy deck expose handles immediately while ensuring the first saved
 * structural operation resolves against byte-identical server-authored identities.
 */
export const backfillLegacyDeckStructure = (html: string): StructuralBackfillResult => {
  const allTags = tags(html)
  if (
    allTags.some(
      (tag) =>
        !tag.closing && STRUCTURAL_ATTRIBUTES.some((attribute) => hasAttr(tag.attrs, attribute)),
    )
  )
    return { html, changed: false, regions: 0, nodes: 0, skipped: [] }

  const slides = sliceSlides(html)
  if (!slides.length) return { html, changed: false, regions: 0, nodes: 0, skipped: [] }
  const known = slides.flatMap((slide) => (slide.id === null ? [] : [slide.id]))
  if (new Set(known).size !== known.length)
    fail("ambiguous-target", "Two slides share one identity, so structural backfill is ambiguous.")
  const usedSlideIds = new Set(known)
  const slideIds = slides.map((slide) => {
    if (slide.id !== null) return slide.id
    const id = nextUnusedSlideId(usedSlideIds)
    usedSlideIds.add(id)
    return id
  })

  const elements = sourceElements(html)
  const byStart = new Map(elements.map((element) => [element.tag.start, element]))
  const replacements: { start: number; end: number; opening: string }[] = []
  const annotatedSlideStarts = new Set<number>()
  const skipped: StructuralBackfillSkip[] = []
  let regions = 0
  let nodes = 0

  for (const [index, slide] of slides.entries()) {
    const position = index + 1
    const slideElement = byStart.get(slide.start)
    if (!slideElement?.explicitlyClosed || slideElement.tag.selfClosing) {
      skipped.push({ slide: position, reason: "implicit-close" })
      continue
    }
    const children = elements
      .filter((element) => element.parentStart === slideElement.tag.start)
      .sort((a, b) => a.tag.start - b.tag.start)
    if (!children.length) {
      skipped.push({ slide: position, reason: "empty" })
      continue
    }
    if (children.some((child) => RUNTIME_CHILDREN.has(child.tag.name))) {
      skipped.push({ slide: position, reason: "runtime-child" })
      continue
    }
    if (children.some((child) => BROWSER_CONTEXT_CHILDREN.has(child.tag.name))) {
      skipped.push({ slide: position, reason: "browser-context-child" })
      continue
    }
    // The interaction client deliberately works with HTMLElements: focusability,
    // tabindex restoration, and semantic width presets are not equivalent on a
    // direct SVG/MathML root. Keep that composition atomic behind an HTML wrapper
    // rather than stamp a handle the client would correctly refuse.
    if (children.some((child) => child.tag.namespace !== "html")) {
      skipped.push({ slide: position, reason: "non-html-child" })
      continue
    }
    if (children.some((child) => !child.explicitlyClosed)) {
      skipped.push({ slide: position, reason: "implicit-close" })
      continue
    }
    let cursor = slideElement.tag.end
    let ownsEverything = true
    for (const child of children) {
      if (!ignorableGap(html.slice(cursor, child.tag.start))) {
        ownsEverything = false
        break
      }
      cursor = child.end
    }
    if (!ownsEverything || !ignorableGap(html.slice(cursor, slideElement.closeStart))) {
      skipped.push({ slide: position, reason: "unowned-content" })
      continue
    }

    const slideId = slideIds[index] as number
    const regionId = `slide-${slideId}`
    let slideOpening = html.slice(slideElement.tag.start, slideElement.tag.end)
    if (slide.id === null)
      slideOpening = setAttribute(slideOpening, "data-derive-slide", String(slideId))
    slideOpening = setAttribute(slideOpening, "data-derive-region", regionId)
    slideOpening = setAttribute(slideOpening, "data-derive-layout", "stack")
    replacements.push({
      start: slideElement.tag.start,
      end: slideElement.tag.end,
      opening: slideOpening,
    })
    annotatedSlideStarts.add(slideElement.tag.start)
    for (const [childIndex, child] of children.entries()) {
      let opening = html.slice(child.tag.start, child.tag.end)
      opening = setAttribute(opening, "data-derive-node", `${regionId}-node-${childIndex + 1}`)
      opening = setAttribute(opening, "data-derive-kind", inferredKind(child.tag.name))
      replacements.push({ start: child.tag.start, end: child.tag.end, opening })
      nodes++
    }
    regions++
  }

  if (!regions) return { html, changed: false, regions, nodes, skipped }
  // Once any slide becomes structurally editable, stamp every class-only sibling's
  // slide identity too. The deck bar prefers explicit identities when even one is
  // present; leaving an unsafe sibling unstamped would make that real slide vanish
  // from navigation even though it correctly remains unavailable for arranging.
  for (const [index, slide] of slides.entries()) {
    if (slide.id !== null || annotatedSlideStarts.has(slide.start)) continue
    const slideElement = byStart.get(slide.start)
    if (!slideElement) continue
    replacements.push({
      start: slideElement.tag.start,
      end: slideElement.tag.end,
      opening: setAttribute(
        html.slice(slideElement.tag.start, slideElement.tag.end),
        "data-derive-slide",
        String(slideIds[index]),
      ),
    })
  }
  let out = html
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    out = out.slice(0, replacement.start) + replacement.opening + out.slice(replacement.end)
  out = injectArtifactRuntimeScripts(out, BACKFILL_STYLE)
  inspect(out)
  return { html: out, changed: out !== html, regions, nodes, skipped }
}

const sizeEdit = (
  html: string,
  edit: StructuralSizeEdit,
  inspection: Inspection,
  label: string,
): { html: string; inverse: StructuralEdit } => {
  const region = regionFor(inspection, edit.region, label)
  const node = nodeFor(region, edit.node, label)
  if (edit.size !== null && !SIZES.has(edit.size))
    fail("invalid-operation", `${label} has unsupported size ${JSON.stringify(edit.size)}.`)
  if (node.size === edit.size) fail("no-change", `${label} leaves node ${node.id} unchanged.`)
  const start = node.element.tag.start
  const end = node.element.tag.end
  const opening = html.slice(start, end)
  const changed = setAttribute(opening, "data-derive-size", edit.size)
  return {
    html: html.slice(0, start) + changed + html.slice(end),
    inverse: {
      schema: STRUCTURAL_EDIT_SCHEMA,
      op: "structural-restore-opening",
      region: region.id,
      node: node.id,
      opening,
    },
  }
}

const restoreOpeningEdit = (
  html: string,
  edit: StructuralOpeningRestoreEdit,
  inspection: Inspection,
  label: string,
): { html: string; inverse: StructuralEdit } => {
  const region = regionFor(inspection, edit.region, label)
  const node = nodeFor(region, edit.node, label)
  if (typeof edit.opening !== "string")
    fail("invalid-operation", `${label} has no opening-tag source.`)
  const parsed = tags(edit.opening)
  const restored = parsed.length === 1 && parsed[0]?.start === 0 ? parsed[0] : undefined
  if (
    !restored ||
    restored.closing ||
    restored.end !== edit.opening.length ||
    restored.name !== node.element.tag.name ||
    attrValues(restored.attrs, "data-derive-node").length !== 1 ||
    attrValues(restored.attrs, "data-derive-node")[0] !== node.id
  )
    fail("invalid-operation", `${label} opening-tag source does not match node ${node.id}.`)
  const start = node.element.tag.start
  const end = node.element.tag.end
  const opening = html.slice(start, end)
  if (opening === edit.opening) fail("no-change", `${label} leaves node ${node.id} unchanged.`)
  return {
    html: html.slice(0, start) + edit.opening + html.slice(end),
    inverse: { ...edit, opening },
  }
}

const orderEdit = (
  html: string,
  edit: StructuralOrderEdit,
  inspection: Inspection,
  label: string,
): { html: string; inverse: StructuralEdit } => {
  const region = regionFor(inspection, edit.region, label)
  if (!Array.isArray(edit.nodes) || edit.nodes.some((id) => typeof id !== "string"))
    fail("invalid-operation", `${label} must provide a complete node order.`)
  const current = region.ownedNodes.map((node) => node.id)
  if (
    edit.nodes.length !== current.length ||
    new Set(edit.nodes).size !== edit.nodes.length ||
    edit.nodes.some((id) => !current.includes(id))
  )
    fail(
      "invalid-operation",
      `${label} must contain every node in region ${region.id} exactly once.`,
    )
  if (edit.nodes.every((id, index) => id === current[index]))
    fail("no-change", `${label} leaves region ${region.id} in its existing order.`)
  const chunks = new Map(
    region.ownedNodes.map((node) => [node.id, html.slice(node.element.tag.start, node.chunkEnd)]),
  )
  const start = region.prefixEnd
  const end = region.element.closeStart
  const reordered = edit.nodes.map((id) => chunks.get(id) ?? "").join("")
  return {
    html: html.slice(0, start) + reordered + html.slice(end),
    inverse: { ...edit, nodes: current },
  }
}

const removeEdit = (
  html: string,
  edit: StructuralRemoveEdit,
  inspection: Inspection,
  label: string,
): { html: string; inverse: StructuralEdit } => {
  const region = regionFor(inspection, edit.region, label)
  const node = nodeFor(region, edit.node, label)
  const index = region.ownedNodes.indexOf(node)
  const start = node.element.tag.start
  const end = node.chunkEnd
  return {
    html: html.slice(0, start) + html.slice(end),
    inverse: {
      schema: STRUCTURAL_EDIT_SCHEMA,
      op: "structural-restore",
      region: region.id,
      node: node.id,
      html: html.slice(start, end),
      before: region.ownedNodes[index + 1]?.id ?? null,
      after: region.ownedNodes[index - 1]?.id ?? null,
    },
  }
}

const restoredNodeId = (source: string, label: string): string => {
  const inspection = inspect(
    `<div data-derive-region="restore" data-derive-layout="stack">${source}</div>`,
  )
  const nodes = inspection.byRegion.get("restore")?.ownedNodes ?? []
  const node = nodes[0]
  if (nodes.length !== 1 || !node)
    throw new StructuralEditError(
      "invalid-operation",
      `${label} restore source must contain exactly one structural node.`,
    )
  return node.id
}

const restoreEdit = (
  html: string,
  edit: StructuralRestoreEdit,
  inspection: Inspection,
  label: string,
): { html: string; inverse: StructuralEdit } => {
  const region = regionFor(inspection, edit.region, label)
  if (typeof edit.html !== "string" || !edit.html)
    fail("invalid-operation", `${label} has no restore source.`)
  if (restoredNodeId(edit.html, label) !== edit.node)
    fail("invalid-operation", `${label} restore source does not match node ${edit.node}.`)
  if (region.ownedNodes.some((node) => node.id === edit.node))
    fail("ambiguous-target", `${label} cannot restore node ${edit.node}; it already exists.`)

  let insert = region.element.closeStart
  if (edit.before !== null) insert = nodeFor(region, edit.before, label).element.tag.start
  else if (edit.after !== null) insert = nodeFor(region, edit.after, label).chunkEnd
  const restored = html.slice(0, insert) + edit.html + html.slice(insert)
  return {
    html: restored,
    inverse: {
      schema: STRUCTURAL_EDIT_SCHEMA,
      op: "structural-remove",
      region: region.id,
      node: edit.node,
    },
  }
}

/** Apply a batch in order. The caller receives nothing if any operation refuses, so
 * publishing can remain atomic around this pure function. */
export const applyStructuralEdits = (
  html: string,
  edits: StructuralEdit[],
): StructuralEditResult => {
  if (!Array.isArray(edits) || edits.length === 0)
    fail("invalid-operation", "`edits` contains no structural operations.")
  if (edits.length > MAX_STRUCTURAL_EDITS)
    fail(
      "invalid-operation",
      `Structural edits has ${edits.length} entries — the maximum per request is ${MAX_STRUCTURAL_EDITS}.`,
    )

  let out = html
  const inverses: StructuralEdit[] = []
  for (const [index, edit] of edits.entries()) {
    const label = `Structural edit ${index + 1} of ${edits.length}`
    if (!isStructuralEdit(edit)) fail("invalid-operation", `${label} is malformed.`)
    const inspection = inspect(out)
    let result: { html: string; inverse: StructuralEdit }
    switch (edit.op) {
      case "structural-size":
        result = sizeEdit(out, edit, inspection, label)
        break
      case "structural-order":
        result = orderEdit(out, edit, inspection, label)
        break
      case "structural-remove":
        result = removeEdit(out, edit, inspection, label)
        break
      case "structural-restore":
        result = restoreEdit(out, edit, inspection, label)
        break
      case "structural-restore-opening":
        result = restoreOpeningEdit(out, edit, inspection, label)
        break
    }
    out = result.html
    inverses.unshift(result.inverse)
  }
  inspect(out)
  return {
    html: out,
    receipt: { schema: STRUCTURAL_RECEIPT_SCHEMA, inverses },
  }
}
