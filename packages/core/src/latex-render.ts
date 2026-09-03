/**
 * The LaTeX-to-HTML walker: turns the tree from latex-parse.ts into the structural web
 * reading of a paper (title block, sections, prose, lists, floats, math placeholders,
 * citations) while latex-emit.ts keeps the text projection in step with the markup.
 *
 * Two passes over the same tree: the first numbers everything and records labels,
 * citations and headings; the second prints, now able to resolve a `\ref` to a figure
 * that comes later. Counters restart between passes so both see the same numbers.
 *
 * Fail-soft is the rule everywhere: an unknown macro prints nothing and leaves a
 * diagnostic, its braces render as plain groups so the words survive; an unknown
 * environment renders its body in a labelled `<div>`. The page is never blank.
 */

import { ACCENT_MARKS, accentChar, LIGATURES, TEXT_SYMBOLS } from "./latex-chars"
import {
  loadBibliography,
  registerLabel,
  renderCite,
  renderRef,
  renderReferences,
  renderTheBibliography,
} from "./latex-cite"
import {
  collectTopMatter,
  detectProfile,
  isTopMatterMacro,
  renderAbstract,
  renderMakeTitle,
  type TopMatter,
} from "./latex-classes"
import {
  attr,
  type ClassProfile,
  Emitter,
  type LatexBindingRef,
  type LatexHeading,
  type LatexTextSegment,
  type RenderContext,
  type RenderOptions,
  step,
} from "./latex-emit"
import {
  renderCaption,
  renderDeriveBinding,
  renderFloat,
  renderIncludeGraphics,
  renderSubFloat,
  renderTabular,
} from "./latex-floats"
import {
  type EnvNode,
  type GroupNode,
  type LatexDiagnostic,
  type LatexNode,
  type MacroDefinition,
  type MacroNode,
  type MathNode,
  parseLatex,
  plainTextOf,
  type TextNode,
  type VerbatimNode,
} from "./latex-parse"

export interface LatexRenderResult {
  /** The `<article>` body, without the document shell. */
  html: string
  text: string
  segments: LatexTextSegment[]
  headings: LatexHeading[]
  bindings: LatexBindingRef[]
  diagnostics: LatexDiagnostic[]
  profile: ClassProfile
  /** `\newcommand` bodies for the math typesetter, keyed by `\name`. */
  macros: Record<string, string>
  title: string | null
  hasMath: boolean
}

const SECTION_LEVELS: Record<string, number> = {
  part: 2,
  chapter: 2,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
}

const TT = ['<span class="derive-tt">', "</span>"] as const
const INLINE_WRAPPERS: Record<string, readonly [string, string]> = {
  emph: ["<em>", "</em>"],
  textit: ["<em>", "</em>"],
  textsl: ["<em>", "</em>"],
  textbf: ["<strong>", "</strong>"],
  texttt: TT,
  path: TT,
  textsc: ['<span class="derive-sc">', "</span>"],
  textsf: ['<span class="derive-sf">', "</span>"],
  underline: ['<span class="derive-underline">', "</span>"],
  uline: ['<span class="derive-underline">', "</span>"],
  sout: ['<span class="derive-strike">', "</span>"],
  textsuperscript: ["<sup>", "</sup>"],
  textsubscript: ["<sub>", "</sub>"],
  textrm: ["", ""],
  textnormal: ["", ""],
  textmd: ["", ""],
  textup: ["", ""],
  mbox: ["", ""],
  hbox: ["", ""],
  fbox: ["", ""],
  makebox: ["", ""],
  parbox: ["", ""],
  raisebox: ["", ""],
  scalebox: ["", ""],
  resizebox: ["", ""],
  rotatebox: ["", ""],
  colorbox: ["", ""],
  fcolorbox: ["", ""],
  textcolor: ["", ""],
  texorpdfstring: ["", ""],
  gls: ["", ""],
  acrshort: ["", ""],
  acrlong: ["", ""],
  ac: ["", ""],
  href: ["", ""],
}

const FONT_SWITCHES: Record<string, readonly [string, string]> = {
  bf: ["<strong>", "</strong>"],
  bfseries: ["<strong>", "</strong>"],
  it: ["<em>", "</em>"],
  itshape: ["<em>", "</em>"],
  em: ["<em>", "</em>"],
  sl: ["<em>", "</em>"],
  slshape: ["<em>", "</em>"],
  tt: TT,
  ttfamily: TT,
  sc: ['<span class="derive-sc">', "</span>"],
  scshape: ['<span class="derive-sc">', "</span>"],
  sf: ['<span class="derive-sf">', "</span>"],
  sffamily: ['<span class="derive-sf">', "</span>"],
  small: ['<span class="derive-small">', "</span>"],
  footnotesize: ['<span class="derive-small">', "</span>"],
  scriptsize: ['<span class="derive-small">', "</span>"],
  tiny: ['<span class="derive-small">', "</span>"],
  large: ['<span class="derive-large">', "</span>"],
  Large: ['<span class="derive-large">', "</span>"],
  LARGE: ['<span class="derive-large">', "</span>"],
  huge: ['<span class="derive-large">', "</span>"],
  Huge: ['<span class="derive-large">', "</span>"],
  rm: ["", ""],
  rmfamily: ["", ""],
  normalfont: ["", ""],
  normalsize: ["", ""],
  mdseries: ["", ""],
  upshape: ["", ""],
}

/** Size and family switches: at the start of a group they wrap it; anywhere else they
 *  print nothing. At block level the wrapper is a div, since a `{\small ...}` around a
 *  bibliography holds sections, not words. */
const BLOCK_SWITCHES = new Set([
  "small",
  "footnotesize",
  "scriptsize",
  "tiny",
  "large",
  "Large",
  "LARGE",
  "huge",
  "Huge",
  "normalsize",
  "tt",
  "ttfamily",
  "sf",
  "sffamily",
  "rm",
  "rmfamily",
  "normalfont",
])

/** Macros that leave no trace on the page. */
const SILENT = new Set([
  ...Object.keys(FONT_SWITCHES),
  "centering",
  "raggedright",
  "raggedleft",
  "noindent",
  "indent",
  "vspace",
  "newpage",
  "clearpage",
  "cleardoublepage",
  "pagebreak",
  "nopagebreak",
  "nolinebreak",
  "balance",
  "hfill",
  "vfill",
  "fill",
  "bigskip",
  "medskip",
  "smallskip",
  "setlength",
  "addtolength",
  "settowidth",
  "newlength",
  "setcounter",
  "addtocounter",
  "stepcounter",
  "refstepcounter",
  "pagestyle",
  "thispagestyle",
  "geometry",
  "lstset",
  "captionsetup",
  "graphicspath",
  "DeclareGraphicsExtensions",
  "newcolumntype",
  "definecolor",
  "providecolor",
  "hypersetup",
  "usepackage",
  "RequirePackage",
  "documentclass",
  "bibliographystyle",
  "tableofcontents",
  "listoffigures",
  "listoftables",
  "Description",
  "theoremstyle",
  "newtheorem",
  "newenvironment",
  "renewenvironment",
  "frenchspacing",
  "nonfrenchspacing",
  "sloppy",
  "fussy",
  "hline",
  "toprule",
  "midrule",
  "bottomrule",
  "cmidrule",
  "cline",
  "addlinespace",
  "protect",
  "relax",
  "hyphenation",
  "selectfont",
  "fontsize",
  "color",
  "phantom",
  "hphantom",
  "vphantom",
  "rule",
  "pdfbookmark",
  "index",
  "glossary",
  "makeatletter",
  "makeatother",
  "columnwidth",
  "textwidth",
  "linewidth",
  "textheight",
  "footnotemark",
  "urlstyle",
  "bibliography",
  "printbibliography",
  "addbibresource",
  "input",
  "include",
  "subfile",
  "label",
  "maketitle",
  "appendix",
  "footnote",
  "footnotetext",
  "thanks",
  "and",
  "item",
  "caption",
  "includegraphics",
  "includepdf",
  "subfloat",
  "derivetable",
  "derivefigure",
  "url",
  "verb",
  "ensuremath",
  "today",
  "linebreak",
  "newline",
  "\\",
  "hspace",
  "anon",
  "si",
  "SI",
  "num",
  "qty",
  "unit",
  "ce",
])

const CITE_MACROS = new Set([
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "shortcite",
  "Citep",
  "Citet",
  "nocite",
])
const REF_MACROS = new Set(["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref"])

/** Built-in handling these names keep even when the document redefines them, because
 *  a redefinition is almost always a spacing tweak, not a change of meaning. */
const PROTECTED = new Set([
  ...Object.keys(SECTION_LEVELS),
  ...CITE_MACROS,
  ...REF_MACROS,
  "label",
  "caption",
  "includegraphics",
  "item",
  "footnote",
  "maketitle",
  "derivetable",
  "derivefigure",
  "url",
  "href",
  "input",
  "include",
  "bibliography",
  "emph",
  "textbf",
  "textit",
  "texttt",
])

const DEFAULT_THEOREMS: Record<string, string> = {
  theorem: "Theorem",
  lemma: "Lemma",
  corollary: "Corollary",
  proposition: "Proposition",
  conjecture: "Conjecture",
  definition: "Definition",
  example: "Example",
  remark: "Remark",
}

const VERBATIM_BLOCKS = new Set([
  "verbatim",
  "verbatim*",
  "Verbatim",
  "BVerbatim",
  "LVerbatim",
  "lstlisting",
  "minted",
  "alltt",
  "algorithmic",
  "algorithmicx",
])
const GRAPHICS_BLOCKS = new Set(["tikzpicture", "pgfpicture", "axis"])
const FLOAT_ENVS = new Set([
  "figure",
  "figure*",
  "table",
  "table*",
  "teaserfigure",
  "wrapfigure",
  "wraptable",
  "algorithm",
  "algorithm*",
  "marginfigure",
  "margintable",
])
const TABULAR_ENVS = new Set(["tabular", "tabular*", "tabularx", "longtable", "array"])
const NUMBERED_MATH = new Set([
  "equation",
  "align",
  "alignat",
  "flalign",
  "gather",
  "multline",
  "eqnarray",
])
const ALIGNED_MATH: Record<string, string> = {
  align: "aligned",
  "align*": "aligned",
  flalign: "aligned",
  "flalign*": "aligned",
  eqnarray: "aligned",
  "eqnarray*": "aligned",
  alignat: "alignedat",
  "alignat*": "alignedat",
  gather: "gathered",
  "gather*": "gathered",
  multline: "gathered",
  "multline*": "gathered",
}

const MAX_EXPANSION_DEPTH = 32
const MAX_EXPANSION_BYTES = 64 * 1024
const MAX_INPUT_DEPTH = 4
const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_DIAGNOSTICS = 64

const isBlankText = (n: LatexNode): boolean => n.type === "text" && !n.value.trim()

const lineCounter =
  (src: string) =>
  (at: number): number => {
    let line = 1
    const end = Math.min(at, src.length)
    for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++
    return line
  }

/** Gather `\newcommand` / `\def` / `\newtheorem` from the whole tree before rendering,
 *  since a definition in the preamble is used in the title block. */
const collectDefinitions = (
  nodes: LatexNode[],
  defs: Map<string, MacroDefinition>,
  theorems: Map<string, { title: string; counter: string }>,
): void => {
  const visit = (list: LatexNode[]) => {
    for (const n of list) {
      if (n.type === "macro") {
        if (n.def) {
          if (n.name === "providecommand" && defs.has(n.def.name)) continue
          if (n.name === "DeclareMathOperator")
            defs.set(n.def.name, { ...n.def, body: `\\operatorname{${n.def.body}}` })
          else defs.set(n.def.name, n.def)
        } else if (n.name === "newtheorem" && n.args.length >= 2) {
          const env = (n.args[0]?.raw ?? "").trim()
          const title = plainTextOf(n.args[1]?.nodes ?? [])
          // \newtheorem{lemma}[theorem]{Lemma}: the bracket shares theorem's counter.
          const shared = n.opt?.raw.trim()
          if (env) theorems.set(env, { title, counter: shared || env })
        } else {
          for (const a of n.args) visit(a.nodes)
        }
      } else if (n.type === "group") visit(n.body)
      else if (n.type === "env") visit(n.body)
    }
  }
  visit(nodes)
}

interface Shared {
  parsed: ParsedShape
  profile: ClassProfile
  top: TopMatter
  defs: Map<string, MacroDefinition>
  theorems: Map<string, { title: string; counter: string }>
  labels: RenderContext["labels"]
  headings: LatexHeading[]
  bindings: LatexBindingRef[]
  diagnostics: LatexDiagnostic[]
  cited: Map<string, number>
  nocite: Set<string>
  bibFiles: string[]
  bibItems: RenderContext["bibItems"]
  unknownMacros: Set<string>
  seenDiagnostics: Set<string>
  hasMath: { value: boolean }
}
type ParsedShape = ReturnType<typeof parseLatex>

const makeContext = (
  source: string,
  opts: RenderOptions,
  shared: Shared,
  pass: 1 | 2,
  bibliography: RenderContext["bibliography"],
): RenderContext => {
  const lineAt = lineCounter(source)
  const ctx: RenderContext = {
    src: source,
    out: new Emitter(),
    parsed: shared.parsed,
    profile: shared.profile,
    opts,
    pass,
    defs: shared.defs,
    labels: shared.labels,
    headings: shared.headings,
    bindings: shared.bindings,
    diagnostics: shared.diagnostics,
    counters: {},
    labelTarget: null,
    float: null,
    theorems: shared.theorems,
    paragraph: "none",
    inlineDepth: 0,
    expansionDepth: 0,
    expansionBytes: 0,
    cited: shared.cited,
    nocite: shared.nocite,
    bibFiles: shared.bibFiles,
    bibItems: shared.bibItems,
    bibliography,
    unknownMacros: shared.unknownMacros,
    walk: (nodes) => walkNodes(ctx, shared, nodes),
    inline: (nodes) => {
      ctx.inlineDepth++
      walkNodes(ctx, shared, nodes)
      ctx.inlineDepth--
    },
    ensureParagraph: (at) => {
      if (ctx.inlineDepth > 0 || ctx.paragraph !== "none") return
      ctx.out.markup("<p>", at)
      ctx.paragraph = "p"
    },
    closeParagraph: (at) => {
      if (ctx.paragraph === "p") ctx.out.markup("</p>", at)
      ctx.paragraph = "none"
    },
    textOf: plainTextOf,
    diag: (code, message, at) => {
      // Pass 2 repeats pass 1's walk; dedupe on code+message so a diagnostic is reported
      // once, and cap the list so a hostile document cannot grow it without bound.
      const key = `${code} ${message}`
      if (shared.seenDiagnostics.has(key) || shared.diagnostics.length >= MAX_DIAGNOSTICS) return
      shared.seenDiagnostics.add(key)
      const inputAt = ctx.counters.inputAt
      shared.diagnostics.push({
        code,
        message,
        line: lineAt(ctx.counters.inputDepth ? (inputAt ?? at) : at),
      })
    },
    lineAt,
  }
  return ctx
}

// ---------------------------------------------------------------------------------
// The walk

const walkNodes = (ctx: RenderContext, shared: Shared, nodes: LatexNode[]): void => {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as LatexNode
    switch (n.type) {
      case "text":
        renderText(ctx, n)
        break
      case "par":
        if (ctx.inlineDepth === 0) {
          const open = ctx.paragraph !== "none"
          ctx.closeParagraph(n.start)
          if (!open) break
        }
        ctx.out.text_(ctx.src.slice(n.start, n.end), n.start)
        break
      case "amp":
        if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
        ctx.out.text_("&", n.start)
        break
      case "group":
        renderGroup(ctx, shared, n)
        break
      case "macro":
        i += renderMacro(ctx, shared, n, nodes, i)
        break
      case "env":
        renderEnv(ctx, shared, n)
        break
      case "math":
        renderMath(ctx, shared, n)
        break
      case "verbatim":
        renderVerbatim(ctx, n)
        break
    }
  }
}

const renderText = (ctx: RenderContext, n: TextNode): void => {
  const { out } = ctx
  const v = n.value
  if (ctx.inlineDepth === 0) {
    // Whitespace between blocks (the newlines after \usepackage lines, between floats)
    // has nowhere to go; dropping it keeps the markup readable and changes no text.
    if (!v.trim() && ctx.paragraph === "none") return
    ctx.ensureParagraph(n.start)
  }
  let run = ""
  let runStart = n.start
  let i = 0
  const flush = () => {
    if (run) out.text_(run, runStart)
    run = ""
  }
  while (i < v.length) {
    let matched = false
    for (const [tex, uni] of LIGATURES) {
      if (v.startsWith(tex, i)) {
        flush()
        if (tex === "~") out.nbsp(n.start + i, n.start + i + 1)
        else out.entity(uni, n.start + i, n.start + i + tex.length)
        i += tex.length
        runStart = n.start + i
        matched = true
        break
      }
    }
    if (matched) continue
    if (!run) runStart = n.start + i
    run += v[i]
    i++
  }
  flush()
}

const renderGroup = (ctx: RenderContext, shared: Shared, n: GroupNode): void => {
  const { out } = ctx
  const first = n.body.find((x) => !isBlankText(x))
  if (first?.type === "macro") {
    const wrap = FONT_SWITCHES[first.name]
    if (wrap && !ctx.defs.has(first.name)) {
      if (BLOCK_SWITCHES.has(first.name) && ctx.inlineDepth === 0 && ctx.paragraph === "none") {
        const cls = /class="([^"]+)"/.exec(wrap[0])?.[1]
        out.markup(cls ? `<div class="${cls}">` : "<div>", n.start)
        walkNodes(ctx, shared, n.body)
        ctx.closeParagraph(n.end)
        out.markup("</div>", n.end)
        return
      }
      if (wrap[0] && ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
      out.markup(wrap[0], n.start)
      walkNodes(ctx, shared, n.body)
      out.markup(wrap[1], n.end)
      return
    }
    if (first.name === "color" && first.args[0]) {
      const color = safeColor(first.args[0].raw)
      if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
      out.markup(color ? `<span style="color:${color}">` : "<span>", n.start)
      walkNodes(ctx, shared, n.body)
      out.markup("</span>", n.end)
      return
    }
    if (first.name === "centering" || first.name === "raggedleft") {
      if (ctx.inlineDepth === 0) {
        ctx.closeParagraph(n.start)
        out.markup(
          `<div class="${first.name === "centering" ? "derive-center" : "derive-flushright"}">`,
          n.start,
        )
        walkNodes(ctx, shared, n.body)
        ctx.closeParagraph(n.end)
        out.markup("</div>", n.end)
        return
      }
    }
  }
  walkNodes(ctx, shared, n.body)
}

const safeColor = (raw: string): string | null => {
  const v = raw.trim()
  if (/^[a-zA-Z]{1,24}$/.test(v)) return v.toLowerCase()
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v
  return null
}

/** Render a macro; returns how many following siblings it consumed (user macros take
 *  their arguments from the groups after them). */
const renderMacro = (
  ctx: RenderContext,
  shared: Shared,
  n: MacroNode,
  siblings: LatexNode[],
  index: number,
): number => {
  const { out } = ctx
  const name = n.name
  if (n.def) return 0
  const def = ctx.defs.get(name)
  if (def && !PROTECTED.has(name)) return expandUserMacro(ctx, shared, n, def, siblings, index)
  if (isTopMatterMacro(name) && name !== "date") return 0
  if (SECTION_LEVELS[name] !== undefined) {
    renderSection(ctx, shared, n)
    return 0
  }
  if (CITE_MACROS.has(name)) {
    if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
    renderCite(ctx, n)
    return 0
  }
  if (REF_MACROS.has(name)) {
    if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
    renderRef(ctx, n)
    return 0
  }
  const wrap = INLINE_WRAPPERS[name]
  if (wrap) {
    renderWrapped(ctx, shared, n, wrap)
    return 0
  }
  const accent = ACCENT_MARKS[name]
  if (accent !== undefined && n.args[0]) {
    if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
    const arg = n.args[0]
    const firstNode = arg.nodes.find((x) => !isBlankText(x))
    const base =
      firstNode?.type === "macro" && (firstNode.name === "i" || firstNode.name === "j")
        ? `\\${firstNode.name}`
        : plainTextOf(arg.nodes)
    out.entity(accentChar(name, base) ?? base, n.start, n.end)
    return 0
  }
  const symbol = TEXT_SYMBOLS[name]
  if (symbol !== undefined) {
    if (symbol && ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
    if (name === "~") out.nbsp(n.start, n.end)
    else if (symbol) out.entity(symbol, n.start, n.end)
    return 0
  }
  switch (name) {
    case "label":
      registerLabel(ctx, n)
      return 0
    case "maketitle":
      renderMakeTitle(ctx, shared.top, n)
      return 0
    case "appendix":
      ctx.counters.appendix = 1
      ctx.counters.section = 0
      ctx.counters.subsection = 0
      ctx.counters.subsubsection = 0
      return 0
    case "\\":
    case "newline":
    case "linebreak":
      if (ctx.paragraph !== "none" || ctx.inlineDepth > 0) out.markup("<br>", n.start)
      return 0
    case "hspace":
      out.entity(" ", n.start, n.end)
      return 0
    case "and":
      out.entity(" and ", n.start, n.end)
      return 0
    case "item":
      // Outside a list environment \item has nothing to attach to; print its label.
      if (n.opt) ctx.inline(n.opt.nodes)
      return 0
    case "caption":
      renderCaption(ctx, n)
      return 0
    case "includegraphics":
    case "includepdf":
      renderIncludeGraphics(ctx, n)
      return 0
    case "subfloat":
      renderSubFloat(ctx, n)
      return 0
    case "derivetable":
      renderDeriveBinding(ctx, n, "table")
      return 0
    case "derivefigure":
      renderDeriveBinding(ctx, n, "figure")
      return 0
    case "footnote":
    case "thanks":
    case "footnotetext":
      renderFootnote(ctx, n)
      return 0
    case "url":
      renderUrl(ctx, n)
      return 0
    case "ensuremath":
      if (n.args[0]) {
        if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
        emitMath(ctx, shared, n.args[0].raw, false, n.start, n.end)
      }
      return 0
    case "input":
    case "include":
    case "subfile":
      renderInput(ctx, shared, n)
      return 0
    case "bibliography":
    case "addbibresource":
      if (ctx.pass === 1 && n.args[0]) {
        ctx.counters.bibliographyAt = n.start
        for (const f of n.args[0].raw.split(",")) {
          const file = f.trim()
          if (file && !ctx.bibFiles.includes(file)) ctx.bibFiles.push(file)
        }
      }
      if (name === "bibliography") renderBibliographyMacro(ctx, shared, n)
      return 0
    case "printbibliography":
      renderBibliographyMacro(ctx, shared, n)
      return 0
    case "today": {
      if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
      out.entity(todayText(), n.start, n.end)
      return 0
    }
    case "anon": {
      // acmart \anon[replacement]{text}: hidden under anonymous, the text otherwise.
      if (ctx.profile.anonymous) {
        if (n.opt) ctx.inline(n.opt.nodes)
        else out.entity("[anonymized]", n.start, n.end)
      } else if (n.args[0]) walkNodes(ctx, shared, n.args[0].nodes)
      return 0
    }
    case "si":
    case "SI":
    case "num":
    case "qty":
    case "unit":
    case "ce": {
      if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
      n.args.forEach((a, i) => {
        if (i > 0) out.nbsp(a.start, a.start)
        ctx.inline(a.nodes)
      })
      return 0
    }
    case "date":
      return 0
    default:
      break
  }
  if (SILENT.has(name) || isTopMatterMacro(name)) return 0
  if (!ctx.unknownMacros.has(name)) {
    ctx.unknownMacros.add(name)
    ctx.diag("unknown-macro", `\\${name} is not supported; its text is kept as written`, n.start)
  }
  // The marker is inline: between blocks there is no paragraph to put it in, and the
  // diagnostic already names the macro.
  if (ctx.inlineDepth > 0 || ctx.paragraph !== "none")
    out.markup(`<span class="derive-unknown" data-latex-unknown="${attr(name)}"></span>`, [
      n.start,
      n.end,
    ])
  return 0
}

const todayText = (): string => {
  const d = new Date()
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

const renderWrapped = (
  ctx: RenderContext,
  shared: Shared,
  n: MacroNode,
  wrap: readonly [string, string],
): void => {
  const { out } = ctx
  // The text argument is the last one (\textcolor{red}{text}, \parbox{3cm}{text}); the
  // first for \texorpdfstring{tex}{pdf} and \href{url}{text} is handled below.
  const arg =
    n.name === "texorpdfstring"
      ? n.args[0]
      : n.name === "anon"
        ? n.args[0]
        : n.args[n.args.length - 1]
  if (!arg) return
  if (ctx.inlineDepth === 0 && plainTextOf(arg.nodes).trim()) ctx.ensureParagraph(n.start)
  if (n.name === "href") {
    const url = n.args[0] ? n.args[0].raw.trim() : ""
    const href = safeHref(url)
    out.markup(href ? `<a href="${attr(href)}">` : "<a>", n.start)
    walkNodes(ctx, shared, arg.nodes)
    out.markup("</a>", n.end)
    return
  }
  if (n.name === "textcolor") {
    const color = n.args[0] ? safeColor(n.args[0].raw) : null
    out.markup(color ? `<span style="color:${color}">` : "<span>", n.start)
    walkNodes(ctx, shared, arg.nodes)
    out.markup("</span>", n.end)
    return
  }
  out.markup(wrap[0], n.start)
  walkNodes(ctx, shared, arg.nodes)
  out.markup(wrap[1], n.end)
}

const safeHref = (url: string): string | null => {
  const v = url.trim()
  if (!v) return null
  if (/^(https?:|mailto:)/i.test(v)) return v
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null
  if (/^[\\/]{2}/.test(v)) return null
  return v
}

const renderUrl = (ctx: RenderContext, n: MacroNode): void => {
  const { out } = ctx
  const arg = n.args[0]
  if (!arg) return
  if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
  // \url takes its argument verbatim (a % inside is part of the address), so print the raw
  // slice rather than the parsed nodes.
  const raw = arg.raw
  const href = safeHref(raw)
  out.markup(href ? `<a href="${attr(href)}">` : "<a>", n.start)
  out.text_(raw, arg.start + 1)
  out.markup("</a>", n.end)
}

const renderFootnote = (ctx: RenderContext, n: MacroNode): void => {
  const { out } = ctx
  const arg = n.args[n.args.length - 1]
  if (!arg) return
  if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
  const num = String(step(ctx, "footnote"))
  out.markup('<sup class="derive-footnote-mark">', n.start)
  out.entity(num, n.start, arg.start)
  out.markup("</sup>")
  out.markup('<span class="derive-footnote" role="note"><span class="derive-footnote-num">')
  out.entity(num, n.start, arg.start)
  out.markup("</span> ")
  ctx.inlineDepth++
  ctx.inline(arg.nodes)
  ctx.inlineDepth--
  out.markup("</span>", n.end)
}

const sectionNumber = (ctx: RenderContext, level: number): string | null => {
  if (level === 2) {
    const n = step(ctx, "section")
    ctx.counters.subsection = 0
    ctx.counters.subsubsection = 0
    return ctx.counters.appendix ? String.fromCharCode(64 + n) : String(n)
  }
  if (level === 3) {
    const n = step(ctx, "subsection")
    ctx.counters.subsubsection = 0
    const s = ctx.counters.section ?? 0
    return `${ctx.counters.appendix ? String.fromCharCode(64 + s) : s}.${n}`
  }
  if (level === 4) {
    const n = step(ctx, "subsubsection")
    const s = ctx.counters.section ?? 0
    return `${ctx.counters.appendix ? String.fromCharCode(64 + s) : s}.${ctx.counters.subsection ?? 0}.${n}`
  }
  return null
}

const renderSection = (ctx: RenderContext, shared: Shared, n: MacroNode): void => {
  const { out } = ctx
  const level = SECTION_LEVELS[n.name] ?? 2
  const title = n.args[n.args.length - 1]
  const numbered = !n.star && level <= 4
  const number = numbered ? sectionNumber(ctx, level) : null
  const inlineTitle = () => {
    if (!title) return
    ctx.inlineDepth++
    ctx.inline(title.nodes)
    ctx.inlineDepth--
  }
  const idx = ctx.counters.headingIndex ?? 0
  ctx.counters.headingIndex = idx + 1
  let heading: LatexHeading
  if (ctx.pass === 1) {
    // Pass 1's markup is thrown away, so print the title first and read its text back:
    // that is the only way to get "\ours{}: Results" with the macro expanded, and the
    // slug has to come from the same text the page shows.
    const t0 = out.text.length
    inlineTitle()
    const text = out.text.slice(t0).replace(/\s+/g, " ").trim()
    const at = ctx.counters.inputDepth ? (ctx.counters.inputAt ?? n.start) : n.start
    heading = {
      level,
      text: number ? `${number} ${text}` : text,
      slug: ctx.opts.slug(text),
      line: ctx.lineAt(at),
      start: at,
      numbered,
    }
    shared.headings.push(heading)
    ctx.labelTarget = { number: number ?? "", kind: "section", id: heading.slug }
    ctx.closeParagraph(n.end)
    return
  }
  heading = shared.headings[idx] ?? {
    level,
    text: "",
    slug: "section",
    line: 0,
    start: n.start,
    numbered,
  }
  ctx.labelTarget = { number: number ?? "", kind: "section", id: heading.slug }
  ctx.closeParagraph(n.start)
  if (level >= 5) {
    // \paragraph{Title}: a run-in heading, the paragraph continues after it.
    out.markup("<p>", n.start)
    ctx.paragraph = "p"
    out.markup(`<strong class="derive-runin" id="${attr(heading.slug)}">`)
    inlineTitle()
    out.markup("</strong> ", n.end)
    return
  }
  const tag = `h${level}`
  const cls = ctx.counters.appendix && level === 2 ? ' class="derive-appendix-title"' : ""
  out.markup(`<${tag} id="${attr(heading.slug)}"${cls}>`, n.start)
  if (number) {
    out.markup('<span class="derive-secnum">')
    out.entity(number, n.start, title ? title.start : n.end)
    out.markup("</span> ")
  }
  inlineTitle()
  out.markup(`</${tag}>`, n.end)
}

/** Expand a `\newcommand` at its use: take the arguments from the sibling groups, splice
 *  them into the body, parse and walk the result with every character attributed to the
 *  macro's span in the document. */
const expandUserMacro = (
  ctx: RenderContext,
  shared: Shared,
  n: MacroNode,
  def: MacroDefinition,
  siblings: LatexNode[],
  index: number,
): number => {
  let j = index + 1
  const args: string[] = []
  const skipBlank = () => {
    while (j < siblings.length && isBlankText(siblings[j] as LatexNode)) j++
  }
  let mandatory = def.params
  if (def.defaultArg !== null && def.params > 0) {
    mandatory--
    skipBlank()
    const next = siblings[j]
    let taken = false
    if (next?.type === "text" && next.value.startsWith("[")) {
      const close = next.value.indexOf("]")
      if (close !== -1) {
        if (close < next.value.length - 1) {
          // Split the text node so the part after `]` still renders on both passes.
          const head: TextNode = {
            type: "text",
            value: next.value.slice(0, close + 1),
            start: next.start,
            end: next.start + close + 1,
          }
          const tail: TextNode = {
            type: "text",
            value: next.value.slice(close + 1),
            start: next.start + close + 1,
            end: next.end,
          }
          siblings.splice(j, 1, head, tail)
        }
        args.push(next.value.slice(1, close))
        j++
        taken = true
      }
    }
    if (!taken) args.push(def.defaultArg)
  }
  for (let k = 0; k < mandatory; k++) {
    skipBlank()
    const next = siblings[j]
    if (!next) {
      args.push("")
      continue
    }
    if (next.type === "group") {
      args.push(ctx.src.slice(next.start + 1, next.end - 1))
      j++
    } else if (next.type === "macro") {
      args.push(ctx.src.slice(next.start, next.end))
      j++
    } else if (next.type === "text") {
      // A single character is a complete argument in TeX (`\foo x`).
      const ch = next.value[0] ?? ""
      if (next.value.length > 1) {
        const head: TextNode = { type: "text", value: ch, start: next.start, end: next.start + 1 }
        const tail: TextNode = {
          type: "text",
          value: next.value.slice(1),
          start: next.start + 1,
          end: next.end,
        }
        siblings.splice(j, 1, head, tail)
      }
      args.push(ch)
      j++
    } else args.push("")
  }
  const consumed = j - index - 1
  const spanEnd = consumed > 0 ? (siblings[j - 1] as LatexNode).end : n.end
  if (ctx.expansionDepth >= MAX_EXPANSION_DEPTH) {
    ctx.diag("macro-recursion", `\\${n.name} expands deeper than 32 levels`, n.start)
    return consumed
  }
  // `##` is a literal `#` inside a definition body; hide it while the parameters are
  // substituted so an argument containing `#1` is not expanded a second time.
  const body = def.body
    .replace(/##/g, "@@hash@@")
    .replace(/#(\d)/g, (_, d: string) => args[Number.parseInt(d, 10) - 1] ?? "")
    .replace(/@@hash@@/g, "#")
  ctx.expansionBytes += body.length
  if (ctx.expansionBytes > MAX_EXPANSION_BYTES) {
    ctx.diag("macro-expansion-limit", "macro expansions exceed 64 kB; the rest is skipped", n.start)
    return consumed
  }
  const parsed = parseLatex(body)
  const prevSrc = ctx.src
  ctx.expansionDepth++
  ctx.src = body
  const outerStart = ctx.counters.inputDepth ? (ctx.counters.inputAt ?? n.start) : n.start
  const outerEnd = ctx.counters.inputDepth ? (ctx.counters.inputAt ?? spanEnd) : spanEnd
  ctx.out.withSynthSpan(outerStart, outerEnd, () => walkNodes(ctx, shared, parsed.nodes))
  ctx.src = prevSrc
  ctx.expansionDepth--
  return consumed
}

const renderInput = (ctx: RenderContext, shared: Shared, n: MacroNode): void => {
  const { out } = ctx
  const arg = n.args[0]
  const name = arg ? plainTextOf(arg.nodes).trim() : ""
  const lookup = ctx.opts.resolve
  const clean = name.replace(/^\.\//, "")
  const text = lookup && clean ? (lookup(clean) ?? lookup(`${clean}.tex`)) : null
  if (text === null || text === undefined) {
    ctx.diag(
      "unresolved-input",
      lookup
        ? `\\${n.name}{${name}}: file not found in this artifact`
        : `\\${n.name}{${name}}: included files need a paper bundle (publish main.tex with its files)`,
      n.start,
    )
    if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
    out.markup('<span class="derive-unknown">', n.start)
    out.entity(`\\${n.name}{${name}}`, n.start, n.end)
    out.markup("</span>", n.end)
    return
  }
  const depth = ctx.counters.inputDepth ?? 0
  const bytes = (ctx.counters.inputBytes ?? 0) + text.length
  if (depth >= MAX_INPUT_DEPTH || bytes > MAX_INPUT_BYTES) {
    ctx.diag("input-limit", `\\input{${name}}: nesting or size limit reached`, n.start)
    return
  }
  const parsed = parseLatex(text)
  collectDefinitions(parsed.nodes, ctx.defs, ctx.theorems)
  const prevSrc = ctx.src
  const prevAt = ctx.counters.inputAt
  ctx.counters.inputDepth = depth + 1
  ctx.counters.inputBytes = bytes
  if (depth === 0) ctx.counters.inputAt = n.start
  ctx.src = text
  out.withSynthSpan(n.start, n.end, () => walkNodes(ctx, shared, parsed.nodes))
  ctx.src = prevSrc
  ctx.counters.inputDepth = depth
  if (prevAt === undefined) delete ctx.counters.inputAt
  else ctx.counters.inputAt = prevAt
}

/** `\bibliography{files}`: a compiled `.bbl` in the bundle wins (it is what the PDF
 *  shows); otherwise the entries are formatted from the `.bib` files. */
const renderBibliographyMacro = (ctx: RenderContext, shared: Shared, n: MacroNode): void => {
  const lookup = ctx.opts.resolve
  const bbl = lookup ? bblText(lookup) : null
  if (bbl) {
    const parsed = parseLatex(bbl)
    const prevSrc = ctx.src
    ctx.src = bbl
    ctx.out.withSynthSpan(n.start, n.end, () => walkNodes(ctx, shared, parsed.nodes))
    ctx.src = prevSrc
    return
  }
  renderReferences(ctx, n)
}

const bblText = (lookup: (path: string) => string | null): string | null => {
  for (const name of ["main.bbl", "paper.bbl", "index.bbl"]) {
    const t = lookup(name)
    if (t) return t
  }
  return null
}

// ---------------------------------------------------------------------------------
// Environments

const renderEnv = (ctx: RenderContext, shared: Shared, n: EnvNode): void => {
  const { out } = ctx
  const name = n.name
  if (name === "document") {
    walkNodes(ctx, shared, n.body)
    ctx.closeParagraph(n.bodyEnd)
    return
  }
  // acmart typesets the abstract and the teaser at \maketitle, wherever they were typed;
  // renderMakeTitle walks them with `hoisting` set so this skip does not fire twice.
  const hoisted = ctx.profile.kind === "acm" && shared.top.maketitle && !ctx.counters.hoisting
  if (name === "abstract") {
    if (hoisted && shared.top.abstract === n) return
    renderAbstract(ctx, n)
    return
  }
  if (name === "teaserfigure") {
    if (hoisted && shared.top.teaser === n) return
    renderFloat(ctx, n)
    return
  }
  if (FLOAT_ENVS.has(name)) {
    renderFloat(ctx, n)
    return
  }
  if (name === "subfigure" || name === "subtable") {
    renderSubFloat(ctx, n)
    return
  }
  if (TABULAR_ENVS.has(name)) {
    renderTabular(ctx, n)
    return
  }
  if (name === "minipage") {
    ctx.closeParagraph(n.start)
    out.markup('<div class="derive-minipage">', n.start)
    walkNodes(ctx, shared, n.body)
    ctx.closeParagraph(n.bodyEnd)
    out.markup("</div>", n.end)
    return
  }
  if (name === "center" || name === "flushleft" || name === "flushright") {
    ctx.closeParagraph(n.start)
    const cls =
      name === "center"
        ? "derive-center"
        : name === "flushright"
          ? "derive-flushright"
          : "derive-flushleft"
    out.markup(`<div class="${cls}">`, n.start)
    walkNodes(ctx, shared, n.body)
    ctx.closeParagraph(n.bodyEnd)
    out.markup("</div>", n.end)
    return
  }
  if (name === "quote" || name === "quotation" || name === "verse") {
    ctx.closeParagraph(n.start)
    out.markup("<blockquote>", n.start)
    walkNodes(ctx, shared, n.body)
    ctx.closeParagraph(n.bodyEnd)
    out.markup("</blockquote>", n.end)
    return
  }
  if (name === "itemize" || name === "enumerate" || name === "description") {
    renderList(ctx, shared, n)
    return
  }
  if (name === "thebibliography") {
    renderTheBibliography(ctx, n)
    return
  }
  if (name === "acks") {
    if (ctx.profile.anonymous) return
    ctx.closeParagraph(n.start)
    out.markup('<h2 id="acknowledgments">', n.start)
    out.entity("Acknowledgments", n.start, n.bodyStart)
    out.markup("</h2>")
    walkNodes(ctx, shared, n.body)
    ctx.closeParagraph(n.bodyEnd)
    return
  }
  if (name === "anonsuppress") {
    if (!ctx.profile.anonymous) walkNodes(ctx, shared, n.body)
    return
  }
  if (name === "printonly" || name === "screenonly" || name === "subequations") {
    walkNodes(ctx, shared, n.body)
    return
  }
  const theorem =
    ctx.theorems.get(name) ??
    (DEFAULT_THEOREMS[name] ? { title: DEFAULT_THEOREMS[name] as string, counter: name } : null)
  if (theorem) {
    renderTheorem(ctx, shared, n, theorem)
    return
  }
  if (name === "proof") {
    ctx.closeParagraph(n.start)
    out.markup('<div class="derive-proof">', n.start)
    out.markup("<p>")
    ctx.paragraph = "p"
    out.markup('<em class="derive-theorem-head">')
    if (n.opt) ctx.inline(n.opt.nodes)
    else out.entity("Proof", n.start, n.bodyStart)
    out.entity(".", n.start, n.bodyStart)
    out.markup("</em> ")
    walkNodes(ctx, shared, n.body)
    out.markup('<span class="derive-proof-end">')
    out.entity("□", n.bodyEnd, n.end)
    out.markup("</span>")
    ctx.closeParagraph(n.bodyEnd)
    out.markup("</div>", n.end)
    return
  }
  if (!ctx.unknownMacros.has(`env:${name}`)) {
    ctx.unknownMacros.add(`env:${name}`)
    ctx.diag(
      "unknown-environment",
      `\\begin{${name}} is not supported; its content is kept`,
      n.start,
    )
  }
  ctx.closeParagraph(n.start)
  out.markup(`<div class="derive-env derive-env-${attr(name.replace(/\*/g, "-star"))}">`, n.start)
  walkNodes(ctx, shared, n.body)
  ctx.closeParagraph(n.bodyEnd)
  out.markup("</div>", n.end)
}

const renderList = (ctx: RenderContext, shared: Shared, n: EnvNode): void => {
  const { out } = ctx
  const tag = n.name === "enumerate" ? "ol" : n.name === "description" ? "dl" : "ul"
  ctx.closeParagraph(n.start)
  const depth = (ctx.counters.listDepth ?? 0) + 1
  ctx.counters.listDepth = depth
  const prevItem = ctx.counters[`enumi${depth}`] ?? 0
  ctx.counters[`enumi${depth}`] = 0
  out.markup(`<${tag}>`, n.start)
  let open: "li" | "dd" | null = null
  const closeItem = (at: number) => {
    if (!open) return
    ctx.closeParagraph(at)
    out.markup(`</${open}>`, at)
    open = null
  }
  for (const node of n.body) {
    if (node.type === "macro" && node.name === "item") {
      closeItem(node.start)
      if (tag === "dl") {
        out.markup("<dt>", node.start)
        if (node.opt) ctx.inline(node.opt.nodes)
        out.markup("</dt><dd>")
        open = "dd"
      } else {
        out.markup("<li>", node.start)
        if (tag === "ol") {
          const num = step(ctx, `enumi${depth}`)
          ctx.labelTarget = { number: String(num), kind: "item", id: "" }
        }
        if (node.opt) {
          out.markup('<span class="derive-item-label">')
          ctx.inline(node.opt.nodes)
          out.markup("</span> ")
        }
        open = "li"
      }
      ctx.paragraph = "implicit"
      continue
    }
    if (!open) {
      if (isBlankText(node)) continue
      out.markup("<li>", node.start)
      open = "li"
      ctx.paragraph = "implicit"
    }
    walkNodes(ctx, shared, [node])
  }
  closeItem(n.bodyEnd)
  out.markup(`</${tag}>`, n.end)
  ctx.counters[`enumi${depth}`] = prevItem
  ctx.counters.listDepth = depth - 1
}

const renderTheorem = (
  ctx: RenderContext,
  shared: Shared,
  n: EnvNode,
  theorem: { title: string; counter: string },
): void => {
  const { out } = ctx
  const num = step(ctx, `thm:${theorem.counter}`)
  const id = `thm-${theorem.counter.replace(/[^a-z0-9]/gi, "-")}-${num}`
  ctx.labelTarget = { number: String(num), kind: "theorem", id }
  ctx.closeParagraph(n.start)
  out.markup(
    `<div class="derive-theorem derive-theorem-${attr(n.name)}" id="${attr(id)}">`,
    n.start,
  )
  out.markup("<p>")
  ctx.paragraph = "p"
  out.markup('<span class="derive-theorem-head">')
  out.entity(`${theorem.title} ${num}`, n.start, n.bodyStart)
  if (n.opt) {
    out.entity(" (", n.start, n.bodyStart)
    ctx.inline(n.opt.nodes)
    out.entity(")", n.start, n.bodyStart)
  }
  out.entity(".", n.start, n.bodyStart)
  out.markup('</span> <span class="derive-theorem-body">')
  walkNodes(ctx, shared, n.body)
  out.markup("</span>")
  ctx.closeParagraph(n.bodyEnd)
  out.markup("</div>", n.end)
}

// ---------------------------------------------------------------------------------
// Math and verbatim

interface PreparedMath {
  tex: string
  numbers: string[]
  labels: { key: string; number: string }[]
}

/** Strip what the typesetter must not see (`\label`, `\tag`, `\nonumber`) and assign
 *  equation numbers per line. */
const prepareMath = (ctx: RenderContext, n: MathNode): PreparedMath => {
  const numbered = n.display && n.env !== null && NUMBERED_MATH.has(n.env)
  const labels: { key: string; line: number }[] = []
  const tags: { tag: string; line: number }[] = []
  const lineOf = (at: number): number => {
    let count = 0
    for (let i = 0; i < at - 1; i++) if (n.tex[i] === "\\" && n.tex[i + 1] === "\\") count++
    return count
  }
  let tex = n.tex.replace(/\\label\s*\{([^}]*)\}/g, (_m, key: string, at: number) => {
    labels.push({ key: key.trim(), line: lineOf(at) })
    return ""
  })
  tex = tex.replace(/\\tag\*?\s*\{([^}]*)\}/g, (_m, tag: string, at: number) => {
    tags.push({ tag, line: lineOf(at) })
    return ""
  })
  const lines = tex.split(/\\\\/)
  const numbers: string[] = []
  const lineNumbers: (string | null)[] = []
  const single = n.env === "equation" || n.env === "multline"
  for (const [i, line] of lines.entries()) {
    const tagged = tags.find((t) => t.line === i)
    if (!numbered || (single && i > 0) || (i === lines.length - 1 && !line.trim() && i > 0)) {
      lineNumbers.push(null)
      continue
    }
    if (tagged) {
      lineNumbers.push(tagged.tag)
      numbers.push(tagged.tag)
      continue
    }
    if (/\\nonumber|\\notag/.test(line)) {
      lineNumbers.push(null)
      continue
    }
    const num = String(step(ctx, "equation"))
    lineNumbers.push(num)
    numbers.push(num)
  }
  tex = tex.replace(/\\nonumber|\\notag/g, "")
  const wrap = n.env ? ALIGNED_MATH[n.env] : undefined
  if (wrap === "alignedat") {
    // alignat{n} carries its column count as an argument the parser already consumed;
    // KaTeX's alignedat needs one, and two columns cover the common case.
    tex = `\\begin{alignedat}{2}${tex}\\end{alignedat}`
  } else if (wrap) tex = `\\begin{${wrap}}${tex}\\end{${wrap}}`
  return {
    tex: tex.trim(),
    numbers,
    labels: labels.map((l) => ({
      key: l.key,
      number: lineNumbers[l.line] ?? numbers[0] ?? "??",
    })),
  }
}

const emitMath = (
  ctx: RenderContext,
  shared: Shared,
  tex: string,
  display: boolean,
  start: number,
  end: number,
  numbers: string[] = [],
): void => {
  const { out } = ctx
  shared.hasMath.value = true
  const span = `<span class="derive-math" data-derive-math="${display ? "display" : "inline"}" data-tex="${attr(tex)}"></span>`
  if (!display) {
    out.markup(span, [start, end])
    return
  }
  ctx.closeParagraph(start)
  const id = numbers[0] ? ` id="eq-${attr(numbers[0])}"` : ""
  out.markup(`<div class="derive-math-display"${id}>`, start)
  out.markup(span, [start, end])
  if (numbers.length) {
    out.markup('<span class="derive-eqnum">')
    const label =
      numbers.length === 1 ? `(${numbers[0]})` : `(${numbers[0]})–(${numbers[numbers.length - 1]})`
    out.entity(label, start, end)
    out.markup("</span>")
  }
  out.markup("</div>", end)
}

const renderMath = (ctx: RenderContext, shared: Shared, n: MathNode): void => {
  const prepared = prepareMath(ctx, n)
  if (ctx.pass === 1) {
    for (const l of prepared.labels)
      if (l.key && !ctx.labels.has(l.key))
        ctx.labels.set(l.key, { number: l.number, kind: "equation", id: `eq-${l.number}` })
  }
  if (!n.display && ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
  emitMath(ctx, shared, prepared.tex, n.display, n.start, n.end, prepared.numbers)
  if (prepared.numbers[0])
    ctx.labelTarget = {
      number: prepared.numbers[0],
      kind: "equation",
      id: `eq-${prepared.numbers[0]}`,
    }
}

const renderVerbatim = (ctx: RenderContext, n: VerbatimNode): void => {
  const { out } = ctx
  if (n.name === "verb") {
    if (ctx.inlineDepth === 0) ctx.ensureParagraph(n.start)
    out.markup("<code>", n.start)
    out.text_(n.text, n.textStart)
    out.markup("</code>", n.end)
    return
  }
  if (n.name === "comment" || n.name === "CCSXML" || n.name.startsWith("filecontents")) return
  if (GRAPHICS_BLOCKS.has(n.name)) {
    ctx.diag(
      "unsupported-tikz",
      `${n.name} drawings are not rendered in the browser; include a PNG or JPEG export`,
      n.start,
    )
    ctx.closeParagraph(n.start)
    out.markup('<div class="derive-figure-missing derive-unsupported" role="img">', n.start)
    out.entity(`${n.name} (not rendered in the browser)`, n.start, n.end)
    out.markup("</div>", n.end)
    return
  }
  if (VERBATIM_BLOCKS.has(n.name) || n.name === "verbatim") {
    ctx.closeParagraph(n.start)
    let text = n.text
    let at = n.textStart
    if (text.startsWith("\n")) {
      text = text.slice(1)
      at++
    }
    if (text.endsWith("\n")) text = text.slice(0, -1)
    out.markup(
      `<pre class="derive-verbatim derive-verbatim-${attr(n.name.replace(/\*/g, ""))}">`,
      n.start,
    )
    out.text_(text, at)
    out.markup("</pre>", n.end)
    return
  }
  ctx.closeParagraph(n.start)
  out.markup('<pre class="derive-verbatim">', n.start)
  out.text_(n.text, n.textStart)
  out.markup("</pre>", n.end)
}

// ---------------------------------------------------------------------------------
// Entry points

const makeShared = (parsed: ParsedShape): Shared => {
  const profile = detectProfile(parsed.nodes)
  const defs = new Map<string, MacroDefinition>()
  const theorems = new Map<string, { title: string; counter: string }>()
  collectDefinitions(parsed.nodes, defs, theorems)
  return {
    parsed,
    profile,
    top: collectTopMatter(parsed.nodes, profile),
    defs,
    theorems,
    labels: new Map(),
    headings: [],
    bindings: [],
    diagnostics: [],
    cited: new Map(),
    nocite: new Set(),
    bibFiles: [],
    bibItems: new Map(),
    unknownMacros: new Set(),
    seenDiagnostics: new Set(),
    hasMath: { value: false },
  }
}

const runPass = (
  source: string,
  opts: RenderOptions,
  shared: Shared,
  pass: 1 | 2,
  bibliography: RenderContext["bibliography"],
): RenderContext => {
  const ctx = makeContext(source, opts, shared, pass, bibliography)
  const { out, profile } = ctx
  out.markup(
    `<article class="derive-paper derive-paper-${profile.kind}" data-latex-class="${attr(profile.documentClass)}"${profile.format ? ` data-latex-format="${attr(profile.format)}"` : ""}>`,
    0,
  )
  walkNodes(ctx, shared, shared.parsed.nodes)
  ctx.closeParagraph(source.length)
  out.markup("</article>", source.length)
  return ctx
}

/** Render a LaTeX document body to HTML with its text projection. Never throws. */
export const renderLatexBody = (source: string, opts: RenderOptions): LatexRenderResult => {
  const parsed = parseLatex(source)
  const shared = makeShared(parsed)
  for (const d of parsed.diagnostics.slice(0, 8)) {
    shared.seenDiagnostics.add(`${d.code} ${d.message}`)
    shared.diagnostics.push(d)
  }
  const first = runPass(source, opts, shared, 1, null)
  const bibliography = loadBibliography(first)
  const ctx = runPass(source, opts, shared, 2, bibliography)
  const macros: Record<string, string> = {}
  for (const [name, def] of shared.defs) macros[`\\${name}`] = def.body
  const titleText = ctx.out.text
    .slice(ctx.counters.titleStart ?? 0, ctx.counters.titleEnd ?? 0)
    .replace(/\s+/g, " ")
    .trim()
  return {
    html: ctx.out.html,
    text: ctx.out.text,
    segments: ctx.out.segments,
    headings: shared.headings,
    bindings: shared.bindings,
    diagnostics: shared.diagnostics,
    profile: shared.profile,
    macros,
    title: titleText || null,
    hasMath: shared.hasMath.value,
  }
}

/** The visible text of the rendered page and the segments that map it onto the source:
 *  the LaTeX twin of `pageTextParts`. Section ids do not affect the text, so no slugger
 *  is needed; callers that also render must pass the same `resolve`/`imageUrl` so
 *  citation labels and figure placeholders agree with the page. */
export const latexTextProjection = (
  source: string,
  opts: Omit<RenderOptions, "slug"> = {},
): { text: string; segments: LatexTextSegment[] } => {
  const r = renderLatexBody(source, { slug: (t) => t, ...opts })
  return { text: r.text, segments: r.segments }
}

/** The section headings of a document with the ids the rendered page uses, for the
 *  outline and section reads. One pass, no HTML. */
export const latexHeadings = (source: string, slug: (text: string) => string): LatexHeading[] => {
  const parsed = parseLatex(source)
  const shared = makeShared(parsed)
  runPass(source, { slug }, shared, 1, null)
  return shared.headings
}
