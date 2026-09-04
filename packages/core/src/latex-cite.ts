/**
 * Citations, cross-references and the reference list for the LaTeX renderer.
 *
 * Pass 1 of the render records every `\label`, `\cite` and `\bibitem`; between the passes
 * `loadBibliography` reads the `.bib` files the document names and picks the cited
 * entries in the style's order; pass 2 prints labels that resolve. Everything printed
 * here is made up from the source rather than copied from it, so it is emitted as
 * entities over the macro that asked for it (see latex-emit.ts).
 *
 * The page cites by number (`[1]`, `[2]`) whatever the class's citation style, and the
 * reference list shows the matching markers. The compiled PDF keeps the class's style
 * (author-year for acmart journals, say); the page is one reading of every paper.
 */

import {
  authorYearLabel,
  type BibEntry,
  parseBibtex,
  referenceParts,
  sortBibEntries,
} from "./bibtex"
import {
  attr,
  type Bibliography,
  type LabelTarget,
  READONLY_ATTR,
  type RenderContext,
} from "./latex-emit"
import type { EnvNode, LatexArg, LatexNode, MacroNode } from "./latex-parse"
import { plainTextOf } from "./latex-parse"

const keysOf = (arg: LatexArg | undefined): string[] =>
  (arg?.raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)

/** An HTML id for a citation key: keys may hold characters an id cannot. */
export const refId = (key: string): string => `ref-${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`

const MAX_BIB_BYTES = 2 * 1024 * 1024

/** Read the `.bib` files pass 1 saw in `\bibliography{...}` (plus any text the caller
 *  handed in) and keep the entries the document cites, in the style's order. */
export const loadBibliography = (ctx: RenderContext): Bibliography | null => {
  const byKey = new Map<string, BibEntry>()
  let bytes = 0
  const sources: { name: string; text: string }[] = []
  const at = ctx.counters.bibliographyAt ?? 0
  for (const name of ctx.bibFiles) {
    const lookup = ctx.opts.resolve
    const text = lookup
      ? (lookup(/\.bib$/i.test(name) ? name : `${name}.bib`) ?? lookup(name))
      : null
    if (text === null || text === undefined) {
      ctx.diag("missing-bibliography", `${name}.bib was not found in this artifact`, at)
      continue
    }
    sources.push({ name, text })
  }
  if (ctx.opts.bibtex) sources.push({ name: "bibtex", text: ctx.opts.bibtex })
  for (const src of sources) {
    bytes += src.text.length
    if (bytes > MAX_BIB_BYTES) {
      ctx.diag("bibliography-too-large", `${src.name}: bibliography files exceed 2 MB`, at)
      break
    }
    const parsed = parseBibtex(src.text)
    for (const d of parsed.diagnostics.slice(0, 4))
      ctx.diag(`bibtex-${d.code}`, `${src.name}.bib line ${d.line}: ${d.message}`, at)
    for (const e of parsed.entries) if (!byKey.has(e.key)) byKey.set(e.key, e)
  }
  if (!sources.length && !ctx.opts.bibtex) return null
  const wanted = ctx.nocite.has("*")
    ? [...byKey.values()]
    : [...byKey.values()].filter((e) => ctx.cited.has(e.key) || ctx.nocite.has(e.key))
  const entries = sortBibEntries(wanted)
  const index = new Map<string, number>()
  for (const [i, e] of entries.entries()) index.set(e.key, i + 1)
  return { entries, index, byKey }
}

interface CiteLabel {
  key: string
  id: string | null
  number: string | null
  authors: string
  year: string
  resolved: boolean
}

const labelFor = (ctx: RenderContext, key: string): CiteLabel => {
  const item = ctx.bibItems.get(key)
  if (item) {
    const ay = item.label ? /^(.*?)\s+(\S+)$/.exec(item.label) : null
    return {
      key,
      id: item.id,
      number: String(item.index),
      authors: ay ? (ay[1] as string) : (item.label ?? String(item.index)),
      year: ay ? (ay[2] as string) : "",
      resolved: true,
    }
  }
  const entry = ctx.bibliography?.byKey.get(key)
  if (entry) {
    const ay = authorYearLabel(entry)
    const n = ctx.bibliography?.index.get(key)
    return {
      key,
      id: refId(key),
      number: n === undefined ? null : String(n),
      authors: ay.authors,
      year: ay.year,
      resolved: true,
    }
  }
  return { key, id: null, number: null, authors: key, year: "", resolved: false }
}

/** Numeric labels in ascending order (natbib's `sort`), and `[1, 2, 3, 6]` as `1-3, 6`
 *  when the style compresses runs. Unresolved keys sort last, as written. */
const numberList = (
  labels: CiteLabel[],
  compress: boolean,
): { text: string; label: CiteLabel }[] => {
  const items = labels
    .map((l) => ({
      text: l.number ?? `${l.key}?`,
      label: l,
      n: Number.parseInt(l.number ?? "", 10),
    }))
    .sort((a, b) => {
      if (Number.isNaN(a.n)) return Number.isNaN(b.n) ? 0 : 1
      if (Number.isNaN(b.n)) return -1
      return a.n - b.n
    })
    .map(({ text, label }) => ({ text, label }))
  if (!compress) return items
  const out: { text: string; label: CiteLabel }[] = []
  let i = 0
  while (i < items.length) {
    let j = i
    const start = Number.parseInt(items[i]?.text ?? "", 10)
    if (Number.isFinite(start)) {
      while (
        j + 1 < items.length &&
        Number.parseInt(items[j + 1]?.text ?? "", 10) === start + (j + 1 - i)
      )
        j++
    }
    if (j - i >= 2) {
      const first = items[i] as { text: string; label: CiteLabel }
      const last = items[j] as { text: string; label: CiteLabel }
      out.push({ text: `${first.text}–${last.text}`, label: first.label })
    } else for (let k = i; k <= j; k++) out.push(items[k] as { text: string; label: CiteLabel })
    i = j + 1
  }
  return out
}

/** Render one citation macro. Pass 1 only records the keys. */
export const renderCite = (ctx: RenderContext, macro: MacroNode): void => {
  const keys = keysOf(macro.args[macro.args.length - 1])
  if (macro.name === "nocite") {
    if (ctx.pass === 1) for (const k of keys) ctx.nocite.add(k)
    return
  }
  if (ctx.pass === 1) {
    for (const k of keys) if (!ctx.cited.has(k)) ctx.cited.set(k, ctx.cited.size + 1)
    return
  }
  const { out, profile } = ctx
  const note = macro.opt ? plainTextOf(macro.opt.nodes).trim() : ""
  const labels = keys.map((k) => labelFor(ctx, k))
  for (const l of labels) {
    if (!l.resolved && !ctx.unknownMacros.has(`cite:${l.key}`)) {
      ctx.unknownMacros.add(`cite:${l.key}`)
      ctx.diag("unresolved-cite", `\\cite{${l.key}}: no entry with this key`, macro.start)
    }
  }
  const say = (text: string) => out.entity(text, macro.start, macro.end)
  const link = (l: CiteLabel, text: string) => {
    if (l.id) out.markup(`<a class="derive-cite" href="#${attr(l.id)}">`, macro.start)
    say(text)
    if (l.id) out.markup("</a>", macro.end)
  }
  const bracket = (fn: () => void) => {
    say("[")
    fn()
    if (note) say(`, ${note}`)
    say("]")
  }
  const sep = (i: number) => {
    if (i > 0) say(", ")
  }
  const numbers = () =>
    numberList(labels, profile.compressCitations).forEach((item, i) => {
      sep(i)
      link(item.label, item.text)
    })
  // The whole label is made up from the macro, so the in-page editor treats it as one
  // read-only island; the brackets and separators are entities over the macro too.
  out.markup(`<span class="derive-citation"${READONLY_ATTR}>`, macro.start)
  switch (macro.name) {
    case "citeauthor":
      labels.forEach((l, i) => {
        sep(i)
        link(l, l.resolved ? l.authors : `${l.key}?`)
      })
      break
    case "citeyear":
      labels.forEach((l, i) => {
        sep(i)
        link(l, l.resolved ? l.year || (l.number ?? "") : `${l.key}?`)
      })
      break
    case "citeyearpar":
      bracket(() =>
        labels.forEach((l, i) => {
          sep(i)
          link(l, l.resolved ? l.year || (l.number ?? "") : `${l.key}?`)
        }),
      )
      break
    case "citet":
    case "Citet":
      // natbib's textual form in a numeric style: `Kerbl et al. [1]`.
      labels.forEach((l, i) => {
        sep(i)
        say(l.resolved ? `${l.authors} ` : "")
        link(l, `[${l.number ?? `${l.key}?`}]`)
      })
      break
    case "citealp":
    case "citealt":
      numbers()
      if (note) say(`, ${note}`)
      break
    default:
      // \cite, \citep, \Citep, \shortcite
      bracket(numbers)
  }
  out.markup("</span>", macro.end)
}

const KIND_WORDS: Record<LabelTarget["kind"], [string, string]> = {
  section: ["Section", "Sec."],
  figure: ["Figure", "Fig."],
  table: ["Table", "Tab."],
  equation: ["Equation", "Eq."],
  theorem: ["Theorem", "Thm."],
  algorithm: ["Algorithm", "Alg."],
  item: ["Item", "Item"],
  other: ["", ""],
}

/** `\ref`, `\eqref`, `\autoref`, `\cref`, `\Cref`, `\nameref`, `\pageref`. */
export const renderRef = (ctx: RenderContext, macro: MacroNode): void => {
  if (ctx.pass === 1) return
  const { out } = ctx
  const keys = keysOf(macro.args[0])
  const say = (text: string) => out.entity(text, macro.start, macro.end)
  out.markup(`<span class="derive-refs"${READONLY_ATTR}>`, macro.start)
  keys.forEach((key, i) => {
    if (i > 0) say(keys.length === 2 || i < keys.length - 1 ? ", " : ", and ")
    const target = ctx.labels.get(key)
    if (!target) {
      if (!ctx.unknownMacros.has(`ref:${key}`)) {
        ctx.unknownMacros.add(`ref:${key}`)
        ctx.diag("unresolved-ref", `\\ref{${key}}: no \\label with this key`, macro.start)
      }
      say("??")
      return
    }
    let text: string
    const [long, short] = KIND_WORDS[target.kind]
    const num = target.kind === "equation" ? `(${target.number})` : target.number
    switch (macro.name) {
      case "eqref":
        text = `(${target.number})`
        break
      case "pageref":
        text = "?"
        break
      case "autoref":
      case "Cref":
        text = long ? `${long} ${num}` : num
        break
      case "cref":
        text = short ? `${short} ${num}` : num
        break
      case "nameref":
        text = target.number
        break
      default:
        text = target.number
    }
    if (target.id) out.markup(`<a class="derive-ref" href="#${attr(target.id)}">`, macro.start)
    say(text)
    if (target.id) out.markup("</a>", macro.end)
  })
  out.markup("</span>", macro.end)
}

/** The label text a `\bibitem[label]{key}` prints; acmart `.bbl` files spell it as
 *  `\protect\citeauthoryear{Names}{Names}{Year}`. */
const bibItemLabel = (opt: LatexArg): string => {
  const find = (nodes: LatexNode[]): MacroNode | null => {
    for (const n of nodes) {
      if (n.type === "macro" && n.name === "citeauthoryear") return n
      if (n.type === "group") {
        const hit = find(n.body)
        if (hit) return hit
      }
    }
    return null
  }
  const cay = find(opt.nodes)
  if (cay && cay.args.length >= 3) {
    const names = plainTextOf((cay.args[0] as LatexArg).nodes)
    const year = plainTextOf((cay.args[2] as LatexArg).nodes)
    return `${names} ${year}`.trim()
  }
  return plainTextOf(opt.nodes)
}

/** The `[n]` (or `\bibitem[label]`) marker that opens a reference entry. The list draws
 *  no browser marker, so the number is real text that reads, copies and projects like
 *  the citation it answers; it is an entity over the producing span (the `\bibitem`, or
 *  the `\bibliography` macro) like every other made-up label. One space follows so the
 *  projection reads `[1] Author`, unless the source spells that space itself. */
const referenceMarker = (
  ctx: RenderContext,
  text: string,
  rStart: number,
  rEnd: number,
  space = true,
) => {
  const { out } = ctx
  out.markup('<span class="derive-reference-label">', rStart)
  out.entity(`[${text}]`, rStart, rEnd)
  out.markup("</span>")
  if (space) out.entity(" ", rStart, rEnd)
}

/** `thebibliography` (hand-written or a compiled `.bbl`): the numbered list whose items
 *  are the citation targets. A `\bibitem[label]` keeps its label as the marker. */
export const renderTheBibliography = (ctx: RenderContext, env: EnvNode): void => {
  const { out } = ctx
  ctx.closeParagraph(env.start)
  out.markup(`<section class="derive-references" id="references"${READONLY_ATTR}>`, env.start)
  out.markup("<h2>")
  out.entity("References", env.start, env.bodyStart)
  out.markup("</h2>")
  out.markup('<ol class="derive-reflist">')
  let index = 0
  let open = false
  const closeItem = (at: number) => {
    if (!open) return
    ctx.closeParagraph(at)
    out.markup("</li>", at)
    open = false
  }
  env.body.forEach((n, i) => {
    if (n.type === "macro" && n.name === "bibitem") {
      closeItem(n.start)
      index++
      const key = (n.args[0]?.raw ?? "").trim()
      const id = refId(key || `item-${index}`)
      const label = n.opt ? bibItemLabel(n.opt) : null
      if (ctx.pass === 1 && key && !ctx.bibItems.has(key))
        ctx.bibItems.set(key, { label, index, id })
      out.markup(`<li id="${attr(id)}">`, n.start)
      // A `.bbl` breaks the line after `\bibitem{key}` and a hand-written list puts a
      // space there; that whitespace already separates the marker from the entry.
      const next = env.body[i + 1]
      const spaced = next?.type === "text" && /^\s/.test(next.value)
      // The marker is the item's number even when \bibitem carries its own label (an
      // author-year .bbl): the text cites by number, and the two must agree.
      referenceMarker(ctx, String(index), n.start, n.end, !spaced)
      ctx.paragraph = "implicit"
      open = true
      return
    }
    if (!open) return
    ctx.walk([n])
  })
  closeItem(env.bodyEnd)
  out.markup("</ol></section>", env.end)
}

/** The reference list built from `.bib` files, printed where `\bibliography` stands. */
export const renderReferences = (ctx: RenderContext, at: { start: number; end: number }): void => {
  if (ctx.pass === 1) return
  const bib = ctx.bibliography
  if (!bib?.entries.length) {
    if (ctx.cited.size && !ctx.bibItems.size)
      ctx.diag(
        "missing-bibliography",
        "citations found but no bibliography entries resolved; add the .bib file to the artifact",
        at.start,
      )
    return
  }
  const { out, profile } = ctx
  ctx.closeParagraph(at.start)
  out.markup(`<section class="derive-references" id="references"${READONLY_ATTR}>`, at.start)
  out.markup("<h2>")
  out.entity("References", at.start, at.end)
  out.markup("</h2>")
  out.markup('<ol class="derive-reflist">')
  bib.entries.forEach((entry, i) => {
    out.markup(`<li id="${attr(refId(entry.key))}">`)
    referenceMarker(ctx, String(i + 1), at.start, at.end)
    for (const part of referenceParts(entry, profile.bibStyle)) {
      if (part.href) {
        out.markup(`<a href="${attr(part.href)}">`)
        out.entity(part.text, at.start, at.end)
        out.markup("</a>")
      } else if (part.italic) {
        out.markup("<em>")
        out.entity(part.text, at.start, at.end)
        out.markup("</em>")
      } else out.entity(part.text, at.start, at.end)
    }
    out.markup("</li>")
  })
  out.markup("</ol></section>", at.end)
}

/** Record what a `\label{key}` names: the most recent numbered thing. */
export const registerLabel = (ctx: RenderContext, macro: MacroNode): void => {
  if (ctx.pass !== 1) return
  const key = (macro.args[0]?.raw ?? "").trim()
  if (!key || ctx.labels.has(key)) return
  ctx.labels.set(key, ctx.labelTarget ?? { number: "??", kind: "other", id: "" })
}
