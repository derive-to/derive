/**
 * Dynamic tables and figures: data a document DECLARES but Derive OWNS, so an agent can
 * update a results table or swap a figure without minting a version.
 *
 * The model is per version. Publishing v(n+1) seeds each bound slot from v(n)'s latest
 * value (or from the inline placeholder for a brand-new name), writes land only on the
 * current version, and older versions keep the data they had. That is the one shape
 * that answers both "why did my history fill with version spam" and "what did v3 say":
 * the version is still the axis of the DOCUMENT, and each version owns a small, revised
 * data store beside it. The inline body of a binding is therefore a SEED for a slot
 * that does not exist yet, never a fallback that competes with the store.
 *
 * This module is the whole contract: name grammar, caps, the value and patch shapes, the
 * pure patch application, the binding parser for each carrier, and the HTML renderers.
 * It imports nothing that imports it (md.ts renders through these helpers), so it stays
 * a leaf the in-frame client, the API, and the stores all read the same numbers from.
 */
import { decodeHTML } from "entities"
import { marked } from "marked"
import { isHtmlLike, isLatexLike, isMarkdownLike } from "./content-types"
import { attrValue, elementEnd, type HtmlTag, tags } from "./html-tags"
import { latexDynamicBindings } from "./latex-dynamic"

/** Same grammar as facts: lowercase, never silently normalized. A string, not a RegExp,
 *  so the injected client can rebuild it and refuse the same names the server refuses. */
export const DYNAMIC_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$"
export const DYNAMIC_MAX_SLOTS = 32
/** Per table, counted in bytes of the serialized value. Big enough for an experiment log,
 *  small enough that a page view (which reads every slot of the version) stays cheap. */
export const DYNAMIC_MAX_BYTES = 512 * 1024
export const DYNAMIC_MAX_ROWS = 10_000
export const DYNAMIC_MAX_COLUMNS = 64
export const DYNAMIC_MAX_PATCH_OPS = 2_000
/** Revisions kept per slot. Revision 0 (the seed) is always kept so a version's start
 *  point can be recovered whatever happened after it. */
export const DYNAMIC_REVISION_LIMIT = 50
const MAX_CELL_CHARS = 4_096
const MAX_TEXT_CHARS = 2_000
const MAX_COLUMN_KEY_CHARS = 64

const NAME = new RegExp(DYNAMIC_NAME_PATTERN)
export const isDynamicName = (name: string): boolean => NAME.test(name)

export type DynamicKind = "table" | "figure"
export type DynamicAlign = "left" | "center" | "right"
export interface DynamicColumn {
  key: string
  label?: string
  align?: DynamicAlign
}
export type DynamicCell = string | number | null
export interface DynamicTable {
  columns: DynamicColumn[]
  rows: Record<string, DynamicCell>[]
  /** The column whose values address rows in a patch. Without it rows are addressed by
   *  index, which breaks the moment a row is inserted; with it a duplicate value is refused. */
  key?: string
}
export interface DynamicFigure {
  /** The image to show. A `/blob/<sha256>.<ext>` capability URL from POST /v1/assets, an
   *  absolute http(s) URL, or null for "no image yet" (rendered as a placeholder box). */
  url: string | null
  /** Bookkeeping ref (`asset:<sha256>`) for the blob behind `url`, when it is a Derive asset. */
  asset?: string
  caption?: string
  alt?: string
  width?: number
  height?: number
}
export type DynamicValue =
  | { kind: "table"; table: DynamicTable }
  | { kind: "figure"; figure: DynamicFigure }
export type DynamicPatch =
  | {
      kind: "table"
      cells?: { row: string | number; col: string; value: DynamicCell }[]
      delete_rows?: (string | number)[]
      append_rows?: Record<string, DynamicCell>[]
    }
  | { kind: "figure"; figure: Partial<DynamicFigure> }

export interface DynamicBinding {
  name: string
  kind: DynamicKind
  /** The inline placeholder, parsed. Null when the document declares the binding without
   *  a usable body (the slot then seeds empty). */
  seed: DynamicValue | null
}

const FIGURE_URL = /^(?:\/blob\/[0-9a-f]{64}(?:\.[a-z0-9]+)?|https?:\/\/[^\s"'<>]+)$/i
const ASSET_REF = /^asset:[0-9a-f]{64}$/
const COLUMN_KEY = /^[^\s"'<>&]{1,64}$/
const ALIGNS = new Set<string>(["left", "center", "right"])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

const isCell = (v: unknown): v is DynamicCell =>
  v === null ||
  (typeof v === "string" && v.length <= MAX_CELL_CHARS) ||
  (typeof v === "number" && Number.isFinite(v))

const validateTable = (v: unknown): DynamicTable | string => {
  if (!isRecord(v)) return "a table must be an object"
  if (!Array.isArray(v.columns) || v.columns.length === 0)
    return "a table needs at least one column"
  if (v.columns.length > DYNAMIC_MAX_COLUMNS)
    return `a table is limited to ${DYNAMIC_MAX_COLUMNS} columns`
  const columns: DynamicColumn[] = []
  const keys = new Set<string>()
  for (const c of v.columns) {
    if (!isRecord(c) || typeof c.key !== "string" || !COLUMN_KEY.test(c.key))
      return "every column needs a key (up to 64 characters, no quotes or angle brackets)"
    if (c.key.length > MAX_COLUMN_KEY_CHARS) return "column keys are limited to 64 characters"
    if (keys.has(c.key)) return `column "${c.key}" is declared twice`
    keys.add(c.key)
    const column: DynamicColumn = { key: c.key }
    if (c.label !== undefined) {
      if (typeof c.label !== "string" || c.label.length > MAX_TEXT_CHARS)
        return `column "${c.key}" has an invalid label`
      column.label = c.label
    }
    if (c.align !== undefined) {
      if (typeof c.align !== "string" || !ALIGNS.has(c.align))
        return `column "${c.key}" align must be left, center, or right`
      column.align = c.align as DynamicAlign
    }
    columns.push(column)
  }
  if (!Array.isArray(v.rows)) return "a table needs a rows array"
  if (v.rows.length > DYNAMIC_MAX_ROWS) return `a table is limited to ${DYNAMIC_MAX_ROWS} rows`
  const rows: Record<string, DynamicCell>[] = []
  for (const r of v.rows) {
    if (!isRecord(r)) return "every row must be an object keyed by column"
    const row: Record<string, DynamicCell> = {}
    for (const [k, cell] of Object.entries(r)) {
      if (!keys.has(k)) return `row references undeclared column "${k}"`
      if (!isCell(cell)) return `cell "${k}" must be a string, a finite number, or null`
      row[k] = cell
    }
    rows.push(row)
  }
  const table: DynamicTable = { columns, rows }
  if (v.key !== undefined) {
    if (typeof v.key !== "string" || !keys.has(v.key)) return "key must name a declared column"
    table.key = v.key
  }
  return table
}

const validateFigure = (v: unknown): DynamicFigure | string => {
  if (!isRecord(v)) return "a figure must be an object"
  if (v.url !== null && (typeof v.url !== "string" || !FIGURE_URL.test(v.url)))
    return "figure url must be a /blob/<hash> asset URL, an http(s) URL, or null"
  const figure: DynamicFigure = { url: v.url as string | null }
  if (v.asset !== undefined) {
    if (typeof v.asset !== "string" || !ASSET_REF.test(v.asset))
      return "asset must be asset:<sha256>"
    figure.asset = v.asset
  }
  for (const field of ["caption", "alt"] as const) {
    const value = v[field]
    if (value === undefined) continue
    if (typeof value !== "string" || value.length > MAX_TEXT_CHARS)
      return `figure ${field} must be a string of up to ${MAX_TEXT_CHARS} characters`
    figure[field] = value
  }
  for (const field of ["width", "height"] as const) {
    const value = v[field]
    if (value === undefined) continue
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000)
      return `figure ${field} must be an integer between 1 and 10000`
    figure[field] = value
  }
  return figure
}

/** Validate a wire value. Returns the normalized value (unknown fields dropped) or the
 *  reason it was refused, in the `apply()` idiom shared-state uses. */
export const validateDynamicValue = (v: unknown): DynamicValue | string => {
  if (!isRecord(v)) return "a dynamic value must be an object with a kind"
  if (v.kind === "table") {
    const table = validateTable(v.table)
    return typeof table === "string" ? table : { kind: "table", table }
  }
  if (v.kind === "figure") {
    const figure = validateFigure(v.figure)
    return typeof figure === "string" ? figure : { kind: "figure", figure }
  }
  return "kind must be table or figure"
}

export const emptyDynamicValue = (kind: DynamicKind): DynamicValue =>
  kind === "table"
    ? { kind: "table", table: { columns: [{ key: "value" }], rows: [] } }
    : { kind: "figure", figure: { url: null } }

export const dynamicValueBytes = (value: DynamicValue): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Resolve a row address against the PRE-batch table. With a key column, the address is
 *  that column's value and a duplicate refuses rather than guesses (the repo's rule for
 *  every address); without one, the address is a 0-based index. */
const rowIndex = (table: DynamicTable, row: string | number): number | string => {
  if (table.key === undefined) {
    if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row >= table.rows.length)
      return `row ${String(row)} is out of range (this table addresses rows by index)`
    return row
  }
  const key = table.key
  const wanted = String(row)
  const matches = table.rows
    .map((r, i) => (String(r[key] ?? "") === wanted ? i : -1))
    .filter((i) => i >= 0)
  if (matches.length === 0) return `no row where ${key} = "${wanted}"`
  if (matches.length > 1)
    return `${matches.length} rows where ${key} = "${wanted}"; refusing to guess`
  return matches[0] as number
}

/** Apply one atomic batch. `cells` and `delete_rows` resolve against the table as it was
 *  before the batch, then `append_rows` land, so nothing in a batch can address a row the
 *  same batch created. Any refusal applies nothing. */
export const applyDynamicPatch = (
  value: DynamicValue,
  patch: DynamicPatch,
): DynamicValue | string => {
  if (patch.kind !== value.kind) return `this slot is a ${value.kind}, not a ${patch.kind}`
  if (value.kind === "figure" && patch.kind === "figure") {
    if (!isRecord(patch.figure)) return "figure patch must be an object"
    return validateDynamicValue({ kind: "figure", figure: { ...value.figure, ...patch.figure } })
  }
  if (value.kind !== "table" || patch.kind !== "table") return "kind mismatch"
  const ops =
    (patch.cells?.length ?? 0) + (patch.delete_rows?.length ?? 0) + (patch.append_rows?.length ?? 0)
  if (ops === 0) return "an empty patch changes nothing"
  if (ops > DYNAMIC_MAX_PATCH_OPS)
    return `a patch is limited to ${DYNAMIC_MAX_PATCH_OPS} operations`
  const before = value.table
  const columns = new Set(before.columns.map((c) => c.key))
  const rows = before.rows.map((r) => ({ ...r }))
  for (const cell of patch.cells ?? []) {
    if (!isRecord(cell) || typeof cell.col !== "string") return "each cell needs row, col, value"
    if (!columns.has(cell.col)) return `unknown column "${cell.col}"`
    if (!isCell(cell.value)) return `cell ${cell.col} must be a string, a finite number, or null`
    const at = rowIndex(before, cell.row as string | number)
    if (typeof at === "string") return at
    const row = rows[at]
    if (row) row[cell.col] = cell.value
  }
  const deleted = new Set<number>()
  for (const address of patch.delete_rows ?? []) {
    const at = rowIndex(before, address)
    if (typeof at === "string") return at
    deleted.add(at)
  }
  const kept = rows.filter((_, i) => !deleted.has(i))
  for (const r of patch.append_rows ?? []) {
    if (!isRecord(r)) return "every appended row must be an object keyed by column"
    kept.push(r as Record<string, DynamicCell>)
  }
  return validateDynamicValue({ kind: "table", table: { ...before, rows: kept } })
}

// ---- Rendering --------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Missing and null cells read as "not yet", which is what a placeholder table says. */
export const EMPTY_CELL = "--"

const cellText = (cell: DynamicCell | undefined): string =>
  cell === null || cell === undefined ? EMPTY_CELL : String(cell)

export const renderDynamicTableInner = (table: DynamicTable): string => {
  const head = table.columns
    .map((c) => `<th${c.align ? ` align="${c.align}"` : ""}>${esc(c.label ?? c.key)}</th>`)
    .join("")
  const body = table.rows
    .map(
      (row) =>
        `<tr>${table.columns
          .map(
            (c) => `<td${c.align ? ` align="${c.align}"` : ""}>${esc(cellText(row[c.key]))}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")
  return `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`
}

export const renderDynamicFigureInner = (figure: DynamicFigure, fallbackCaption = ""): string => {
  const caption = figure.caption ?? fallbackCaption
  const figcaption = caption ? `<figcaption>${esc(caption)}</figcaption>` : ""
  if (!figure.url)
    return `<div class="derive-figure-empty" role="img" aria-label="${esc(figure.alt ?? "No image yet")}">No image yet</div>${figcaption}`
  const size = `${figure.width ? ` width="${figure.width}"` : ""}${figure.height ? ` height="${figure.height}"` : ""}`
  return `<img src="${esc(figure.url)}" alt="${esc(figure.alt ?? caption)}"${size}>${figcaption}`
}

export const renderDynamicTable = (name: string, table: DynamicTable): string =>
  `<table data-derive-table="${esc(name)}">${renderDynamicTableInner(table)}</table>`

export const renderDynamicFigure = (name: string, figure: DynamicFigure): string =>
  `<figure data-derive-figure="${esc(name)}">${renderDynamicFigureInner(figure)}</figure>`

export const renderDynamicValue = (name: string, value: DynamicValue): string =>
  value.kind === "table"
    ? renderDynamicTable(name, value.table)
    : renderDynamicFigure(name, value.figure)

// ---- Bindings ---------------------------------------------------------------------

const stripTags = (html: string): string =>
  decodeHTML(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()

const slugKey = (label: string, taken: Set<string>): string => {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_COLUMN_KEY_CHARS - 4) || "col"
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`
  taken.add(key)
  return key
}

/** A GFM pipe table or a JSON table body becomes a table seed; `--`, a dash, or an empty
 *  cell reads as null (the placeholder convention), a plain number reads as a number. */
const seedCell = (raw: string): DynamicCell => {
  const t = raw.trim()
  if (t === "" || t === "--" || t === "-" || t === "—") return null
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t
}

const pipeRow = (line: string): string[] => {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim())
}

const parsePipeTable = (body: string): DynamicTable | string => {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) return "a table placeholder needs a header row and a separator row"
  const header = pipeRow(lines[0] as string)
  const separator = pipeRow(lines[1] as string)
  if (!separator.every((c) => /^:?-{1,}:?$/.test(c)))
    return "the second row must be a | --- | separator"
  const taken = new Set<string>()
  const columns: DynamicColumn[] = header.map((label, i) => {
    const column: DynamicColumn = { key: slugKey(label, taken), label }
    const sep = separator[i] ?? ""
    if (sep.startsWith(":") && sep.endsWith(":")) column.align = "center"
    else if (sep.endsWith(":")) column.align = "right"
    return column
  })
  const rows = lines.slice(2).map((line) => {
    const cells = pipeRow(line)
    const row: Record<string, DynamicCell> = {}
    columns.forEach((c, i) => {
      row[c.key] = seedCell(cells[i] ?? "")
    })
    return row
  })
  return { columns, rows }
}

const parseSeedBody = (kind: DynamicKind, body: string): DynamicValue | string => {
  const trimmed = body.trim()
  if (trimmed === "") return emptyDynamicValue(kind)
  if (trimmed.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return "the placeholder body is not valid JSON"
    }
    if (kind === "table") {
      const table = isRecord(parsed) && "columns" in parsed ? parsed : null
      return table
        ? validateDynamicValue({ kind: "table", table })
        : "a JSON table needs columns and rows"
    }
    return validateDynamicValue({
      kind: "figure",
      figure: { url: null, ...(isRecord(parsed) ? parsed : {}) },
    })
  }
  if (kind === "figure") return "a figure placeholder body must be JSON"
  const table = parsePipeTable(trimmed)
  return typeof table === "string" ? table : { kind: "table", table }
}

/** The fence info strings this parser and the markdown renderer both understand. */
export const DYNAMIC_FENCE = /^derive-(table|figure)\s+(\S+)\s*$/
export const parseDynamicFence = (
  lang: string | undefined,
): { kind: DynamicKind; name: string } | null => {
  const m = DYNAMIC_FENCE.exec(lang ?? "")
  return m ? { kind: m[1] as DynamicKind, name: m[2] as string } : null
}

/** Render one markdown fence body as its seed (used when no slot exists yet). */
export const renderDynamicSeed = (kind: DynamicKind, name: string, body: string): string => {
  const seed = parseSeedBody(kind, body)
  return renderDynamicValue(name, typeof seed === "string" ? emptyDynamicValue(kind) : seed)
}

interface MarkdownCodeToken {
  type?: string
  lang?: string
  text?: string
  tokens?: MarkdownCodeToken[]
  items?: MarkdownCodeToken[]
}

const closeTagIndex = (all: HtmlTag[], i: number): number => {
  const end = elementEnd(all, i)
  if (end === -1) return -1
  for (let k = i + 1; k < all.length; k++) {
    const tag = all[k] as HtmlTag
    if (tag.end === end) return k
  }
  return -1
}

const innerRange = (
  all: HtmlTag[],
  i: number,
): { start: number; end: number; close: number } | null => {
  const open = all[i] as HtmlTag
  const close = closeTagIndex(all, i)
  if (close === -1) return null
  return { start: open.end, end: (all[close] as HtmlTag).start, close }
}

const htmlTableSeed = (
  html: string,
  all: HtmlTag[],
  i: number,
  close: number,
): DynamicTable | null => {
  const rows: { header: boolean; cells: string[] }[] = []
  let current: { header: boolean; cells: string[] } | null = null
  let inHead = false
  for (let k = i + 1; k < close; k++) {
    const tag = all[k] as HtmlTag
    if (tag.name === "thead") inHead = !tag.closing
    if (tag.closing) continue
    if (tag.name === "tr") {
      current = { header: inHead, cells: [] }
      rows.push(current)
    } else if ((tag.name === "td" || tag.name === "th") && current) {
      const end = elementEnd(all, k)
      const text = end === -1 ? "" : stripTags(html.slice(tag.end, Math.min(end, html.length)))
      if (tag.name === "th") current.header = true
      current.cells.push(text)
    }
  }
  if (rows.length === 0) return null
  const first = rows[0] as { header: boolean; cells: string[] }
  const taken = new Set<string>()
  const columns: DynamicColumn[] = first.header
    ? first.cells.map((label) => ({ key: slugKey(label, taken), label }))
    : first.cells.map((_, n) => ({ key: slugKey(`col ${n + 1}`, taken) }))
  const data = first.header ? rows.slice(1) : rows
  return {
    columns,
    rows: data.map((r) => {
      const row: Record<string, DynamicCell> = {}
      columns.forEach((c, n) => {
        row[c.key] = seedCell(r.cells[n] ?? "")
      })
      return row
    }),
  }
}

const htmlFigureSeed = (html: string, all: HtmlTag[], i: number, close: number): DynamicFigure => {
  const figure: DynamicFigure = { url: null }
  for (let k = i + 1; k < close; k++) {
    const tag = all[k] as HtmlTag
    if (tag.closing) continue
    if (tag.name === "img" && figure.url === null) {
      const src = attrValue(tag.attrs, "src") ?? ""
      if (FIGURE_URL.test(src)) figure.url = src
      const alt = attrValue(tag.attrs, "alt")
      if (alt) figure.alt = decodeHTML(alt).slice(0, MAX_TEXT_CHARS)
    } else if (tag.name === "figcaption" && figure.caption === undefined) {
      const end = elementEnd(all, k)
      if (end !== -1) figure.caption = stripTags(html.slice(tag.end, end)).slice(0, MAX_TEXT_CHARS)
    }
  }
  return figure
}

export interface DynamicBindings {
  bindings: DynamicBinding[]
  advisories: string[]
}

/** Every binding a document declares, with its seed. HTML-like carriers bind through
 *  `data-derive-table` / `data-derive-figure`; Markdown through the two fences. First
 *  occurrence of a name wins; an unusable seed keeps the binding (it seeds empty) and says
 *  so, because a document must never lose a slot over a typo in its placeholder. */
export const parseDynamicBindings = (source: string, contentType: string): DynamicBindings => {
  const bindings: DynamicBinding[] = []
  const advisories: string[] = []
  const seen = new Set<string>()
  const add = (name: string, kind: DynamicKind, seed: DynamicValue | string) => {
    if (!isDynamicName(name)) {
      advisories.push(
        `Dynamic ${kind} "${name}" was ignored: names are lowercase letters, digits and dashes.`,
      )
      return
    }
    if (seen.has(name)) return
    if (bindings.length >= DYNAMIC_MAX_SLOTS) {
      advisories.push(
        `Dynamic ${kind} "${name}" was ignored: a version is limited to ${DYNAMIC_MAX_SLOTS} slots.`,
      )
      return
    }
    seen.add(name)
    if (typeof seed === "string") {
      advisories.push(`Dynamic ${kind} "${name}" seeds empty: ${seed}.`)
      bindings.push({ name, kind, seed: null })
    } else bindings.push({ name, kind, seed })
  }
  if (isLatexLike(contentType)) {
    // \derivetable{name} / \derivefigure{name}: no inline seed in LaTeX (the macro's
    // optional argument is layout, not data), so a new name starts empty.
    for (const b of latexDynamicBindings(source)) add(b.name, b.kind, emptyDynamicValue(b.kind))
    return { bindings, advisories }
  }
  if (isMarkdownLike(contentType)) {
    const walk = (tokens: MarkdownCodeToken[]) => {
      for (const token of tokens) {
        if (token.type === "code") {
          const fence = parseDynamicFence(token.lang)
          if (fence) add(fence.name, fence.kind, parseSeedBody(fence.kind, token.text ?? ""))
        }
        if (token.tokens) walk(token.tokens)
        if (token.items) walk(token.items)
      }
    }
    walk(marked.lexer(source, { gfm: true }) as unknown as MarkdownCodeToken[])
    return { bindings, advisories }
  }
  if (!isHtmlLike(contentType)) return { bindings, advisories }
  const all = tags(source)
  for (let i = 0; i < all.length; i++) {
    const tag = all[i] as HtmlTag
    if (tag.closing || tag.namespace !== "html") continue
    if (tag.name === "table") {
      const name = attrValue(tag.attrs, "data-derive-table")
      if (name === null) continue
      const range = innerRange(all, i)
      const seed = range ? htmlTableSeed(source, all, i, range.close) : null
      add(
        name,
        "table",
        seed ? { kind: "table", table: seed } : "the placeholder table has no rows",
      )
    } else if (tag.name === "figure") {
      const name = attrValue(tag.attrs, "data-derive-figure")
      if (name === null) continue
      const range = innerRange(all, i)
      add(name, "figure", {
        kind: "figure",
        figure: range ? htmlFigureSeed(source, all, i, range.close) : { url: null },
      })
    }
  }
  return { bindings, advisories }
}

/** Serve-time substitution for an HTML carrier: every bound element whose slot exists gets
 *  its inner markup replaced by the slot's render; a leading authored `<caption>` is kept
 *  (it is prose, not data); an element whose name has no slot is left byte-identical. */
export const applyDynamicBindings = (
  html: string,
  slots: ReadonlyMap<string, DynamicValue>,
): string => {
  if (slots.size === 0) return html
  const all = tags(html)
  const edits: { start: number; end: number; inner: string }[] = []
  let skipUntil = -1
  for (let i = 0; i < all.length; i++) {
    const tag = all[i] as HtmlTag
    if (tag.closing || tag.namespace !== "html" || tag.start < skipUntil) continue
    const attr =
      tag.name === "table"
        ? "data-derive-table"
        : tag.name === "figure"
          ? "data-derive-figure"
          : null
    if (!attr) continue
    const name = attrValue(tag.attrs, attr)
    if (name === null) continue
    const slot = slots.get(name)
    if (!slot || (tag.name === "table" ? slot.kind !== "table" : slot.kind !== "figure")) continue
    const range = innerRange(all, i)
    if (!range) continue
    let keep = ""
    let fallbackCaption = ""
    for (let k = i + 1; k < range.close; k++) {
      const child = all[k] as HtmlTag
      if (child.closing) continue
      if (tag.name === "table") {
        // Only a caption that opens the table is prose worth keeping; anything else in
        // there is the placeholder data the slot replaces.
        if (child.name === "caption" && html.slice(range.start, child.start).trim() === "") {
          const end = elementEnd(all, k)
          if (end !== -1) keep = html.slice(child.start, end)
        }
        break
      }
      if (child.name === "figcaption") {
        const end = elementEnd(all, k)
        if (end !== -1) fallbackCaption = stripTags(html.slice(child.end, end))
        break
      }
    }
    const inner =
      slot.kind === "table"
        ? keep + renderDynamicTableInner(slot.table)
        : renderDynamicFigureInner(slot.figure, fallbackCaption)
    edits.push({ start: range.start, end: range.end, inner })
    skipUntil = range.end
  }
  let out = html
  for (const edit of edits.reverse())
    out = out.slice(0, edit.start) + edit.inner + out.slice(edit.end)
  return out
}
