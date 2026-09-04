/**
 * Floats and tables for the LaTeX renderer: `tabular` and its relatives, `figure` /
 * `table` / `algorithm` environments with numbered captions, `\includegraphics`,
 * sub-floats, and the `\derivetable` / `\derivefigure` bindings that emit the same
 * `data-derive-*` markup the Markdown and HTML paths use, so one live-update runtime
 * serves all three.
 */

import {
  emptyDynamicValue,
  isDynamicName,
  renderDynamicFigureInner,
  renderDynamicTableInner,
} from "./dynamic-data"
import {
  attr,
  type DynamicFigureLike,
  type DynamicTableLike,
  type FloatState,
  READONLY_ATTR,
  type RenderContext,
  step,
} from "./latex-emit"
import { type EnvNode, type LatexNode, type MacroNode, plainTextOf } from "./latex-parse"

export type CellAlign = "left" | "center" | "right"

export interface ColumnSpec {
  align: CellAlign
  borderLeft: boolean
}

const readGroup = (spec: string, from: number): { inner: string; end: number } | null => {
  if (spec[from] !== "{") return null
  let level = 0
  for (let i = from; i < spec.length; i++) {
    if (spec[i] === "{") level++
    else if (spec[i] === "}") {
      level--
      if (level === 0) return { inner: spec.slice(from + 1, i), end: i + 1 }
    }
  }
  return null
}

/** A tabular column specification (`l c r p{3cm} | @{} *{3}{c}`) as a column list. */
export const parseColumnSpec = (spec: string): ColumnSpec[] => {
  const cols: ColumnSpec[] = []
  let border = false
  let i = 0
  const push = (align: CellAlign) => {
    cols.push({ align, borderLeft: border })
    border = false
  }
  while (i < spec.length) {
    const ch = spec[i] as string
    if (ch === "l") push("left")
    else if (ch === "c") push("center")
    else if (ch === "r" || ch === "S" || ch === "N" || ch === "D") push("right")
    else if (
      ch === "p" ||
      ch === "m" ||
      ch === "b" ||
      ch === "X" ||
      ch === "L" ||
      ch === "C" ||
      ch === "R"
    ) {
      push(ch === "C" ? "center" : ch === "R" ? "right" : "left")
      const g = readGroup(spec, i + 1)
      if (g) {
        i = g.end
        continue
      }
    } else if (ch === "|") border = true
    else if (ch === "@" || ch === "!" || ch === ">" || ch === "<") {
      const g = readGroup(spec, i + 1)
      if (g) {
        i = g.end
        continue
      }
    } else if (ch === "*") {
      const count = readGroup(spec, i + 1)
      const body = count ? readGroup(spec, count.end) : null
      if (count && body) {
        const n = Math.min(64, Number.parseInt(count.inner, 10) || 0)
        for (let k = 0; k < n; k++) cols.push(...parseColumnSpec(body.inner))
        i = body.end
        continue
      }
    }
    i++
  }
  return cols
}

interface Cell {
  nodes: LatexNode[]
  colspan: number
  rowspan: number
  align: CellAlign | null
  start: number
}
interface Row {
  cells: Cell[]
  ruleAbove: boolean
  start: number
}

const RULES = new Set([
  "hline",
  "toprule",
  "midrule",
  "bottomrule",
  "cmidrule",
  "cline",
  "specialrule",
  "addlinespace",
  "morecmidrules",
])

const isBlank = (nodes: LatexNode[]): boolean =>
  nodes.every((n) => n.type === "text" && !n.value.trim())

/** A cell without the whitespace around its content (`\toprule\n    Method `): edge text
 *  nodes are copied with the whitespace sliced off and their offsets moved, so the text
 *  still maps 1:1 onto the source. */
const trimCell = (nodes: LatexNode[]): LatexNode[] => {
  let a = 0
  let b = nodes.length
  while (a < b && isBlank([nodes[a] as LatexNode])) a++
  while (b > a && isBlank([nodes[b - 1] as LatexNode])) b--
  const out = nodes.slice(a, b)
  const first = out[0]
  if (first?.type === "text") {
    const lead = first.value.length - first.value.trimStart().length
    if (lead) out[0] = { ...first, value: first.value.slice(lead), start: first.start + lead }
  }
  const last = out[out.length - 1]
  if (last?.type === "text") {
    const trail = last.value.length - last.value.trimEnd().length
    if (trail)
      out[out.length - 1] = { ...last, value: last.value.slice(0, -trail), end: last.end - trail }
  }
  return out
}

/** Split a tabular body into rows and cells. Rules mark the row that follows them;
 *  `\multicolumn` and `\multirow` become spans; the empty row after the last `\\` is
 *  dropped. */
const tabularRows = (body: LatexNode[], start: number): { rows: Row[]; firstMidrule: number } => {
  const rows: Row[] = []
  let cells: Cell[] = []
  let cur: Cell = { nodes: [], colspan: 1, rowspan: 1, align: null, start }
  let rowStart = start
  let ruleAbove = false
  let firstMidrule = -1
  const endCell = () => {
    cells.push(cur)
  }
  const endRow = (at: number, next: number) => {
    endCell()
    rows.push({ cells, ruleAbove, start: rowStart })
    cells = []
    ruleAbove = false
    cur = { nodes: [], colspan: 1, rowspan: 1, align: null, start: next }
    rowStart = at
  }
  for (const n of body) {
    if (n.type === "amp") {
      endCell()
      cur = { nodes: [], colspan: 1, rowspan: 1, align: null, start: n.end }
      continue
    }
    if (n.type === "macro") {
      if (n.name === "\\" || n.name === "tabularnewline") {
        endRow(n.start, n.end)
        continue
      }
      if (RULES.has(n.name)) {
        if (n.name === "midrule" && firstMidrule === -1) firstMidrule = rows.length
        ruleAbove = true
        continue
      }
      if (n.name === "multicolumn" && n.args.length === 3) {
        const span = Number.parseInt((n.args[0] as { raw: string }).raw, 10) || 1
        const spec = parseColumnSpec((n.args[1] as { raw: string }).raw)
        cur = {
          nodes: (n.args[2] as { nodes: LatexNode[] }).nodes,
          colspan: Math.max(1, Math.min(span, 64)),
          rowspan: cur.rowspan,
          align: spec[0]?.align ?? null,
          start: n.start,
        }
        continue
      }
      if (n.name === "multirow" && n.args.length >= 3) {
        const span = Number.parseInt((n.args[0] as { raw: string }).raw, 10) || 1
        cur = {
          nodes: (n.args[n.args.length - 1] as { nodes: LatexNode[] }).nodes,
          colspan: cur.colspan,
          rowspan: Math.max(1, Math.min(span, 64)),
          align: cur.align,
          start: n.start,
        }
        continue
      }
    }
    cur.nodes.push(n)
  }
  if (cells.length || !isBlank(cur.nodes)) {
    endCell()
    rows.push({ cells, ruleAbove, start: rowStart })
  }
  return { rows, firstMidrule }
}

const specArgOf = (env: EnvNode): string => {
  // tabular{spec}, tabular*{width}{spec}, tabularx{width}{spec}, longtable{spec}, array{spec}
  const last = env.args[env.args.length - 1]
  return last ? last.raw : ""
}

export const renderTabular = (ctx: RenderContext, env: EnvNode): void => {
  const { out } = ctx
  const cols = parseColumnSpec(specArgOf(env))
  const { rows, firstMidrule } = tabularRows(env.body, env.bodyStart)
  // Header rows: everything above the first \midrule (booktabs), or the first row when it
  // sits between two \hline rules the way classic LaTeX tables are drawn.
  let headerRows = firstMidrule > 0 ? firstMidrule : 0
  if (firstMidrule === -1 && rows.length > 1 && rows[0]?.ruleAbove && rows[1]?.ruleAbove)
    headerRows = 1
  ctx.closeParagraph(env.start)
  out.markup(`<table class="derive-tabular"${READONLY_ATTR}>`, env.start)
  const pending = new Map<number, number>()
  const emitRow = (row: Row, header: boolean) => {
    out.markup(`<tr${row.ruleAbove ? ' class="derive-rule-above"' : ""}>`, row.start)
    let col = 0
    for (const cell of row.cells) {
      const remaining = pending.get(col) ?? 0
      if (remaining > 0 && isBlank(cell.nodes)) {
        // A cell under a \multirow: TeX leaves it empty, HTML must leave it out.
        pending.set(col, remaining - 1)
        col += cell.colspan
        continue
      }
      const align = cell.align ?? cols[col]?.align ?? null
      const tag = header ? "th" : "td"
      const attrs = [
        align && align !== "left" ? ` align="${align}"` : "",
        cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "",
        cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "",
      ].join("")
      if (cell.rowspan > 1) pending.set(col, cell.rowspan - 1)
      out.markup(`<${tag}${attrs}>`, cell.start)
      ctx.inline(trimCell(cell.nodes))
      out.markup(`</${tag}>`)
      col += cell.colspan
    }
    out.markup("</tr>")
  }
  if (headerRows > 0) {
    out.markup("<thead>")
    for (const row of rows.slice(0, headerRows)) emitRow(row, true)
    out.markup("</thead>")
  }
  out.markup("<tbody>")
  for (const row of rows.slice(headerRows)) emitRow(row, false)
  out.markup("</tbody></table>", env.end)
}

/** `Figure 1: ` in proceedings, `Fig. 1. ` in ACM journals, `Figure 1. ` for CVPR. */
export const captionLabel = (ctx: RenderContext, kind: FloatState["kind"], n: string): string => {
  const p = ctx.profile
  if (kind === "algorithm") return `Algorithm ${n} `
  const word = kind === "table" ? "Table" : p.kind === "acm" && p.journal ? "Fig." : "Figure"
  const sep = p.kind === "cvpr" || (p.kind === "acm" && p.journal) ? "." : ":"
  return `${word} ${n}${sep} `
}

const findDescription = (nodes: LatexNode[]): string | null => {
  for (const n of nodes) {
    if (n.type === "macro" && n.name === "Description" && n.args[0])
      return plainTextOf(n.args[0].nodes)
    if (n.type === "group") {
      const d = findDescription(n.body)
      if (d) return d
    }
  }
  return null
}

const floatKind = (name: string): FloatState["kind"] =>
  name.startsWith("table") || name === "wraptable" || name === "margintable"
    ? "table"
    : name.startsWith("algorithm")
      ? "algorithm"
      : "figure"

const ID_PREFIX: Record<FloatState["kind"], string> = {
  figure: "fig",
  table: "tab",
  algorithm: "alg",
}

export const renderFloat = (ctx: RenderContext, env: EnvNode): void => {
  const { out } = ctx
  const kind = floatKind(env.name)
  const n = step(ctx, kind)
  const number = ctx.counters.appendix
    ? `${String.fromCharCode(64 + ctx.counters.appendix)}.${n}`
    : String(n)
  const id = `${ID_PREFIX[kind]}-${number}`
  const state: FloatState = {
    kind,
    number,
    id,
    captionLabel: captionLabel(ctx, kind, number),
    description: findDescription(env.body),
    sub: 0,
  }
  ctx.labelTarget = { number, kind, id }
  ctx.closeParagraph(env.start)
  const wide = env.name.endsWith("*") ? " derive-float-wide" : ""
  const teaser = env.name === "teaserfigure" ? " derive-teaser" : ""
  out.markup(`<figure class="derive-float derive-${kind}${wide}${teaser}" id="${id}">`, env.start)
  const prev = ctx.float
  ctx.float = state
  ctx.walk(env.body)
  ctx.closeParagraph(env.bodyEnd)
  ctx.float = prev
  out.markup("</figure>", env.end)
}

export const renderCaption = (ctx: RenderContext, macro: MacroNode): void => {
  const { out } = ctx
  const text = macro.args[macro.args.length - 1]
  const label = ctx.float?.captionLabel ?? ""
  ctx.closeParagraph(macro.start)
  out.markup("<figcaption>", macro.start)
  if (label) {
    out.markup(`<span class="derive-caption-label"${READONLY_ATTR}>`)
    out.entity(label, macro.start, text ? text.start : macro.end)
    out.markup("</span>")
  }
  ctx.inlineDepth++
  if (text) ctx.inline(text.nodes)
  ctx.inlineDepth--
  out.markup("</figcaption>", macro.end)
}

/** `subfigure` environments and `\subfloat[caption]{content}`: lettered inside the
 *  enclosing float. */
export const renderSubFloat = (ctx: RenderContext, node: EnvNode | MacroNode): void => {
  const { out } = ctx
  const parent = ctx.float
  const letter = parent ? String.fromCharCode(97 + parent.sub++) : ""
  const number = parent ? `${parent.number}${letter}` : letter
  const id = parent ? `${parent.id}${letter}` : `sub-${letter}`
  const state: FloatState = {
    kind: parent?.kind ?? "figure",
    number,
    id,
    captionLabel: letter ? `(${letter}) ` : "",
    description: parent?.description ?? null,
    sub: 0,
  }
  ctx.labelTarget = { number, kind: state.kind, id }
  ctx.closeParagraph(node.start)
  out.markup(`<figure class="derive-subfloat" id="${id}">`, node.start)
  ctx.float = state
  if (node.type === "env") ctx.walk(node.body)
  else {
    const content = node.args[0]
    if (content) ctx.walk(content.nodes)
    ctx.closeParagraph(node.end)
    if (node.opt) {
      out.markup("<figcaption>", node.opt.start)
      out.markup(`<span class="derive-caption-label"${READONLY_ATTR}>`)
      out.entity(state.captionLabel, node.start, node.opt.start)
      out.markup("</span>")
      ctx.inline(node.opt.nodes)
      out.markup("</figcaption>", node.opt.end)
    }
  }
  ctx.closeParagraph(node.end)
  ctx.float = parent
  out.markup("</figure>", node.end)
  if (parent) ctx.labelTarget = { number: parent.number, kind: parent.kind, id: parent.id }
}

const parseKeyVals = (raw: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=")
    if (eq === -1) {
      const k = part.trim()
      if (k) out[k] = ""
    } else out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

const PX_PER: Record<string, number> = {
  in: 96,
  cm: 37.8,
  mm: 3.78,
  pt: 1.333,
  bp: 1.333,
  pc: 16,
  em: 16,
  ex: 8,
  px: 1,
}

/** A TeX length as a CSS value: fractions of the line width become percentages, absolute
 *  units become pixels. Null for anything else (`\the\dimexpr...`, macros). */
export const lengthToCss = (value: string): string | null => {
  const v = value.trim()
  const rel =
    /^([0-9.]*)\s*\\(linewidth|columnwidth|textwidth|hsize|paperwidth|textheight|columnheight)$/.exec(
      v,
    )
  if (rel) {
    const f = rel[1] ? Number.parseFloat(rel[1]) : 1
    if (!Number.isFinite(f)) return null
    return `${Math.min(100, Math.round(f * 1000) / 10)}%`
  }
  const abs = /^([0-9.]+)\s*(in|cm|mm|pt|bp|pc|em|ex|px)$/.exec(v)
  if (abs) {
    const f = Number.parseFloat(abs[1] as string) * (PX_PER[abs[2] as string] ?? 1)
    if (!Number.isFinite(f)) return null
    return `${Math.round(f)}px`
  }
  return null
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"]

const resolveImage = (ctx: RenderContext, path: string): string | null => {
  if (/^https?:\/\//i.test(path) || /^\/blob\/[0-9a-f]{64}(\.[a-z0-9]+)?$/i.test(path)) return path
  const lookup = ctx.opts.imageUrl
  if (!lookup) return null
  const clean = path.replace(/^\.\//, "")
  const direct = lookup(clean)
  if (direct) return direct
  if (/\.[a-z0-9]+$/i.test(clean)) return null
  for (const ext of IMAGE_EXTENSIONS) {
    const hit = lookup(`${clean}.${ext}`)
    if (hit) return hit
  }
  return null
}

export const renderIncludeGraphics = (ctx: RenderContext, macro: MacroNode): void => {
  const { out } = ctx
  const arg = macro.args[0]
  const path = arg ? plainTextOf(arg.nodes).trim() : ""
  const opts = parseKeyVals(macro.opt?.raw)
  const styles: string[] = []
  const width = opts.width ? lengthToCss(opts.width) : null
  const height = opts.height ? lengthToCss(opts.height) : null
  if (width) styles.push(`width:${width}`)
  if (height) styles.push(`height:${height}`)
  if (!width && opts.scale) {
    const f = Number.parseFloat(opts.scale)
    if (Number.isFinite(f) && f > 0 && f <= 1) styles.push(`width:${Math.round(f * 100)}%`)
  }
  const style = styles.length ? ` style="${styles.join(";")}"` : ""
  const inFloat = ctx.float !== null
  if (inFloat) ctx.closeParagraph(macro.start)
  else ctx.ensureParagraph(macro.start)
  const url = path ? resolveImage(ctx, path) : null
  if (!url) {
    const isPdf = /\.(pdf|eps|ps)$/i.test(path)
    ctx.diag(
      isPdf ? "figure-format" : "figure-path",
      isPdf
        ? `${path}: PDF and EPS figures cannot be shown in the browser; add a PNG or JPEG`
        : `${path || "\\includegraphics"}: figure not found in this artifact`,
      macro.start,
    )
    out.markup(
      `<span class="derive-figure-missing" role="img" aria-label="${attr(path)}">`,
      macro.start,
    )
    out.entity(path || "figure", macro.start, macro.end)
    out.markup("</span>", macro.end)
    return
  }
  const alt = ctx.float?.description ?? ""
  out.markup(`<img src="${attr(url)}" alt="${attr(alt)}"${style}${READONLY_ATTR}>`, [
    macro.start,
    macro.end,
  ])
}

// The placeholder before a slot exists must be byte-identical to the seeded empty value
// (emptyDynamicValue), so the first render and the first seeded render agree.
const emptyTable = (): DynamicTableLike => {
  const v = emptyDynamicValue("table")
  return v.kind === "table" ? v.table : { columns: [], rows: [] }
}
const EMPTY_FIGURE: DynamicFigureLike = { url: null }

/** `\derivetable[opts]{name}` / `\derivefigure[opts]{name}`: the bound element with the
 *  slot's current value, or the empty placeholder before the slot has data. */
export const renderDeriveBinding = (
  ctx: RenderContext,
  macro: MacroNode,
  kind: "table" | "figure",
): void => {
  const { out } = ctx
  const arg = macro.args[0]
  const name = arg ? arg.raw.trim() : ""
  if (!isDynamicName(name)) {
    ctx.diag(
      "dynamic-name",
      `\\derive${kind}{${name}}: names are lowercase letters, digits and dashes (up to 64)`,
      macro.start,
    )
    ctx.ensureParagraph(macro.start)
    out.markup(`<span class="derive-unknown"${READONLY_ATTR}>`, macro.start)
    out.entity(`\\derive${kind}{${name}}`, macro.start, macro.end)
    out.markup("</span>", macro.end)
    return
  }
  if (ctx.pass === 1 && !ctx.bindings.some((b) => b.name === name))
    ctx.bindings.push({ name, kind, start: macro.start, end: macro.end })
  const value = ctx.opts.dynamic?.get(name)
  const opts = parseKeyVals(macro.opt?.raw)
  ctx.closeParagraph(macro.start)
  if (kind === "table") {
    const table = value?.kind === "table" ? value.table : emptyTable()
    out.markup(
      `<table data-derive-table="${attr(name)}" class="derive-tabular derive-dynamic"${READONLY_ATTR}>`,
      macro.start,
    )
    out.markup(renderDynamicTableInner(table), [macro.start, macro.end])
    out.markup("</table>", macro.end)
    return
  }
  const figure = value?.kind === "figure" ? value.figure : EMPTY_FIGURE
  out.markup(
    `<figure data-derive-figure="${attr(name)}" class="derive-dynamic"${READONLY_ATTR}>`,
    macro.start,
  )
  out.markup(renderDynamicFigureInner(figure, opts.caption ?? ""), [macro.start, macro.end])
  out.markup("</figure>", macro.end)
}
