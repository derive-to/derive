/**
 * A LaTeX reader for the structural HTML tier: a tokenizer and a parser that turn a
 * document into a tree whose every node remembers the source offsets it came from, so
 * the renderer can project visible text back onto the bytes (comment anchoring, inline
 * edits) the way markdown-text.ts does for Markdown.
 *
 * It is deliberately NOT a TeX engine. Macros are read by a small arity table, not
 * expanded by TeX's rules; the one rule that keeps unknown input harmless is that an
 * unknown macro takes NO arguments, so `\foo{bar}` becomes an inert macro followed by a
 * plain group and the word `bar` still renders. Verbatim families are captured raw before
 * anything else looks at them; math is captured as its TeX for the client to typeset.
 * Nothing here throws on hostile input: a stray `}` or an unclosed group is a diagnostic,
 * never a blank page.
 *
 * Leaf module: no imports, no DOM, no Node, so it runs on the Workers tier like the
 * markdown path and can be bundled into a browser client later.
 */

export interface LatexDiagnostic {
  code: string
  message: string
  line: number
}

interface Base {
  start: number
  end: number
}
/** A run of ordinary characters, exactly `source.slice(start, end)`. */
export interface TextNode extends Base {
  type: "text"
  value: string
}
/** A blank line (paragraph break) or an explicit `\par`. */
export interface ParNode extends Base {
  type: "par"
}
/** An alignment tab `&` (tables, align environments read as text). */
export interface AmpNode extends Base {
  type: "amp"
}
export interface LatexArg extends Base {
  nodes: LatexNode[]
  /** The source between the braces (or brackets), exactly. */
  raw: string
}
/** A macro definition read from `\newcommand`, `\renewcommand`, `\providecommand`,
 *  `\def` or `\DeclareMathOperator`. `body` is the raw source so the renderer can expand
 *  it in text mode and hand it to the math typesetter unchanged. */
export interface MacroDefinition {
  name: string
  params: number
  defaultArg: string | null
  body: string
}
export interface MacroNode extends Base {
  type: "macro"
  /** The control-word name without the backslash (`section`), or the single character of
   *  a control symbol (`%`, `\\`, `'`). */
  name: string
  star: boolean
  opt: LatexArg | null
  /** A parenthesised argument (`\cmidrule(lr){2-3}`), when the signature allows one. */
  paren: LatexArg | null
  args: LatexArg[]
  def?: MacroDefinition
}
export interface GroupNode extends Base {
  type: "group"
  body: LatexNode[]
}
export interface EnvNode extends Base {
  type: "env"
  name: string
  opt: LatexArg | null
  args: LatexArg[]
  body: LatexNode[]
  bodyStart: number
  bodyEnd: number
}
export interface MathNode extends Base {
  type: "math"
  display: boolean
  /** The environment that carried the math (`align`), when it was an environment. */
  env: string | null
  tex: string
  texStart: number
  texEnd: number
}
/** Raw captured content: verbatim families, listings, `\verb`, and dropped blocks. */
export interface VerbatimNode extends Base {
  type: "verbatim"
  name: string
  opt: LatexArg | null
  args: LatexArg[]
  text: string
  textStart: number
  textEnd: number
}
export type LatexNode =
  | TextNode
  | ParNode
  | AmpNode
  | MacroNode
  | GroupNode
  | EnvNode
  | MathNode
  | VerbatimNode

export interface ParsedLatex {
  source: string
  nodes: LatexNode[]
  diagnostics: LatexDiagnostic[]
}

/** Argument signatures: `o` an optional `[…]`, `m` a mandatory `{…}` (or the next token),
 *  `p` an optional `(…)`. Everything not listed takes nothing, on purpose. */
export const MACRO_SIGNATURES: Record<string, string> = {
  // sectioning and structure
  part: "om",
  chapter: "om",
  section: "om",
  subsection: "om",
  subsubsection: "om",
  paragraph: "om",
  subparagraph: "om",
  item: "o",
  caption: "om",
  label: "m",
  ref: "m",
  eqref: "m",
  pageref: "m",
  autoref: "m",
  cref: "m",
  Cref: "m",
  nameref: "m",
  footnote: "om",
  footnotemark: "o",
  footnotetext: "om",
  input: "m",
  include: "m",
  includegraphics: "om",
  includepdf: "om",
  url: "m",
  href: "mm",
  path: "m",
  cite: "om",
  citep: "om",
  citet: "om",
  citealp: "om",
  citealt: "om",
  citeauthor: "om",
  citeyear: "om",
  citeyearpar: "om",
  shortcite: "om",
  Citep: "om",
  Citet: "om",
  nocite: "m",
  bibliography: "m",
  bibliographystyle: "m",
  addbibresource: "om",
  bibitem: "om",
  // formatting
  emph: "m",
  textbf: "m",
  textit: "m",
  texttt: "m",
  textsc: "m",
  textsf: "m",
  textrm: "m",
  textmd: "m",
  textup: "m",
  textsl: "m",
  textnormal: "m",
  underline: "m",
  uline: "m",
  sout: "m",
  textsuperscript: "m",
  textsubscript: "m",
  textcolor: "mm",
  color: "m",
  colorbox: "mm",
  fcolorbox: "mmm",
  mbox: "m",
  hbox: "m",
  fbox: "m",
  makebox: "om",
  parbox: "omm",
  raisebox: "mm",
  scalebox: "mm",
  resizebox: "mmm",
  rotatebox: "mm",
  hspace: "m",
  vspace: "m",
  hphantom: "m",
  vphantom: "m",
  phantom: "m",
  rule: "omm",
  setlength: "mm",
  addtolength: "mm",
  settowidth: "mm",
  newlength: "m",
  linebreak: "o",
  pagebreak: "o",
  newline: "",
  "\\": "o",
  // accents (control symbols) and text symbols
  "'": "m",
  '"': "m",
  "^": "m",
  "`": "m",
  "~": "m",
  "=": "m",
  ".": "m",
  c: "m",
  v: "m",
  u: "m",
  H: "m",
  k: "m",
  r: "m",
  b: "m",
  d: "m",
  t: "m",
  // tables
  multicolumn: "mmm",
  multirow: "ommm",
  cmidrule: "opm",
  cline: "m",
  cellcolor: "om",
  rowcolor: "om",
  columncolor: "om",
  arrayrulecolor: "m",
  // floats
  subfloat: "om",
  centering: "",
  // theorem-like
  newtheorem: "momo",
  theoremstyle: "m",
  // definitions (read specially, listed for their trailing groups)
  newenvironment: "moomm",
  renewenvironment: "moomm",
  // preamble
  documentclass: "om",
  usepackage: "om",
  RequirePackage: "om",
  title: "om",
  subtitle: "m",
  author: "m",
  date: "m",
  thanks: "m",
  and: "",
  // acmart
  orcid: "m",
  email: "m",
  affiliation: "om",
  additionalaffiliation: "m",
  institution: "m",
  department: "om",
  streetaddress: "m",
  city: "m",
  state: "m",
  postcode: "m",
  country: "m",
  position: "m",
  authornote: "m",
  authornotemark: "o",
  titlenote: "m",
  subtitlenote: "m",
  authorsaddresses: "m",
  acmConference: "ommm",
  acmBooktitle: "m",
  acmJournal: "m",
  acmYear: "m",
  copyrightyear: "m",
  acmVolume: "m",
  acmNumber: "m",
  acmArticle: "m",
  acmArticleSeq: "m",
  acmMonth: "m",
  acmDOI: "m",
  acmISBN: "m",
  acmPrice: "m",
  acmSubmissionID: "m",
  acmArticleType: "m",
  acmCodeLink: "m",
  acmDataLink: "m",
  acmBadgeR: "om",
  acmBadgeL: "om",
  startPage: "m",
  setcopyright: "m",
  setcctype: "om",
  settopmatter: "m",
  citestyle: "m",
  setcitestyle: "m",
  received: "om",
  ccsdesc: "om",
  keywords: "m",
  Description: "om",
  grantsponsor: "mmm",
  grantnum: "omm",
  anon: "om",
  // cvpr
  paperID: "m",
  cvprPaperID: "m",
  confName: "m",
  confYear: "m",
  // derive
  derivetable: "om",
  derivefigure: "om",
  // math-ish in text mode
  DeclareMathOperator: "mm",
  ensuremath: "m",
  // misc
  todo: "om",
  marginpar: "om",
  index: "m",
  glossary: "m",
  gls: "m",
  acrshort: "m",
  acrlong: "m",
  ac: "m",
  si: "m",
  SI: "omm",
  num: "om",
  qty: "omm",
  unit: "om",
  ce: "m",
  texorpdfstring: "mm",
  pdfbookmark: "omm",
  hypersetup: "m",
  setcounter: "mm",
  addtocounter: "mm",
  stepcounter: "m",
  refstepcounter: "m",
  pagestyle: "m",
  thispagestyle: "m",
  geometry: "m",
  lstset: "m",
  lstinputlisting: "om",
  captionsetup: "om",
  graphicspath: "m",
  DeclareGraphicsExtensions: "m",
  newcolumntype: "omm",
  definecolor: "mmm",
  providecolor: "mmm",
  columnwidth: "",
  textwidth: "",
  linewidth: "",
  textheight: "",
  balance: "",
  maketitle: "",
  tableofcontents: "",
  appendix: "",
  hline: "",
  toprule: "o",
  midrule: "o",
  bottomrule: "o",
  addlinespace: "o",
  noindent: "",
  indent: "",
  par: "",
  clearpage: "",
  newpage: "",
  cleardoublepage: "",
  bigskip: "",
  medskip: "",
  smallskip: "",
  hfill: "",
  vfill: "",
  fill: "",
  today: "",
  LaTeX: "",
  TeX: "",
  ldots: "",
  dots: "",
  textellipsis: "",
  ss: "",
  ae: "",
  oe: "",
  AE: "",
  OE: "",
  o: "",
  O: "",
  aa: "",
  AA: "",
  l: "",
  L: "",
  i: "",
  j: "",
  S: "",
  P: "",
  dag: "",
  ddag: "",
  copyright: "",
  textregistered: "",
  texttrademark: "",
  textdegree: "",
  textbullet: "",
  textquoteleft: "",
  textquoteright: "",
  textquotedblleft: "",
  textquotedblright: "",
  textendash: "",
  textemdash: "",
  textbackslash: "",
  textasciitilde: "",
  textasciicircum: "",
  textbar: "",
  textless: "",
  textgreater: "",
  textunderscore: "",
  textvisiblespace: "",
  textperiodcentered: "",
  textapprox: "",
  euro: "",
  pounds: "",
  checkmark: "",
  quad: "",
  qquad: "",
  enspace: "",
  thinspace: "",
  negthinspace: "",
  slash: "",
  "-": "",
  "/": "",
  " ": "",
  ",": "",
  ";": "",
  "!": "",
  ":": "",
  "@": "",
  "%": "",
  "&": "",
  "#": "",
  $: "",
  _: "",
  "{": "",
  "}": "",
}

export interface EnvSpec {
  /** Argument signature after `\begin{name}`, same alphabet as macros. */
  sig?: string
  /** Body captured raw up to `\end{name}`. */
  verbatim?: boolean
  /** Body is TeX math for the typesetter. */
  math?: boolean
  /** Body is never shown (metadata the class consumes, or a comment). */
  drop?: boolean
}

export const ENV_SPECS: Record<string, EnvSpec> = {
  document: {},
  abstract: {},
  figure: { sig: "o" },
  "figure*": { sig: "o" },
  table: { sig: "o" },
  "table*": { sig: "o" },
  teaserfigure: {},
  wrapfigure: { sig: "omm" },
  wraptable: { sig: "omm" },
  subfigure: { sig: "om" },
  subtable: { sig: "om" },
  minipage: { sig: "om" },
  tabular: { sig: "om" },
  "tabular*": { sig: "mom" },
  tabularx: { sig: "mom" },
  longtable: { sig: "om" },
  array: { sig: "om" },
  center: {},
  flushleft: {},
  flushright: {},
  quote: {},
  quotation: {},
  itemize: { sig: "o" },
  enumerate: { sig: "o" },
  description: { sig: "o" },
  thebibliography: { sig: "m" },
  acks: {},
  anonsuppress: {},
  printonly: {},
  screenonly: {},
  algorithm: { sig: "o" },
  "algorithm*": { sig: "o" },
  algorithmic: { sig: "o", verbatim: true },
  algorithmicx: { sig: "o", verbatim: true },
  verbatim: { verbatim: true },
  "verbatim*": { verbatim: true },
  Verbatim: { sig: "o", verbatim: true },
  BVerbatim: { sig: "o", verbatim: true },
  LVerbatim: { sig: "o", verbatim: true },
  lstlisting: { sig: "o", verbatim: true },
  minted: { sig: "om", verbatim: true },
  alltt: { verbatim: true },
  filecontents: { sig: "om", verbatim: true, drop: true },
  "filecontents*": { sig: "om", verbatim: true, drop: true },
  comment: { verbatim: true, drop: true },
  CCSXML: { verbatim: true, drop: true },
  tikzpicture: { sig: "o", verbatim: true },
  pgfpicture: { verbatim: true },
  axis: { sig: "o", verbatim: true },
  equation: { math: true },
  "equation*": { math: true },
  align: { math: true },
  "align*": { math: true },
  alignat: { sig: "m", math: true },
  "alignat*": { sig: "m", math: true },
  flalign: { math: true },
  "flalign*": { math: true },
  gather: { math: true },
  "gather*": { math: true },
  multline: { math: true },
  "multline*": { math: true },
  eqnarray: { math: true },
  "eqnarray*": { math: true },
  displaymath: { math: true },
  math: { math: true },
  "math*": { math: true },
  subequations: {},
  theorem: { sig: "o" },
  lemma: { sig: "o" },
  corollary: { sig: "o" },
  proposition: { sig: "o" },
  conjecture: { sig: "o" },
  definition: { sig: "o" },
  example: { sig: "o" },
  remark: { sig: "o" },
  proof: { sig: "o" },
  translatedabstract: { sig: "m" },
  sidebar: {},
  marginfigure: {},
  margintable: {},
}

const DEFINERS = new Set(["newcommand", "renewcommand", "providecommand", "DeclareMathOperator"])
const MAX_DEPTH = 256

const isLetter = (ch: string): boolean => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")
const isSpace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f"

/** Parse a LaTeX document into a tree with source offsets. Never throws. */
export const parseLatex = (source: string): ParsedLatex => {
  const src = source
  const diagnostics: LatexDiagnostic[] = []
  let pos = 0
  let depth = 0
  const lineAt = (at: number): number => {
    let line = 1
    for (let i = 0; i < at && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
    return line
  }
  const diag = (code: string, message: string, at: number) => {
    if (diagnostics.length < 64) diagnostics.push({ code, message, line: lineAt(at) })
  }

  /** Skip spaces and at most one line break, the way TeX skips the space after a control
   *  word; a blank line (paragraph break) is left for the caller to see. */
  const skipInlineSpace = () => {
    while (pos < src.length && (src[pos] === " " || src[pos] === "\t")) pos++
    if (src[pos] === "\n" || src[pos] === "\r") {
      let look = pos + 1
      if (src[pos] === "\r" && src[look] === "\n") look++
      let probe = look
      while (probe < src.length && (src[probe] === " " || src[probe] === "\t")) probe++
      if (src[probe] !== "\n" && src[probe] !== "\r") {
        pos = look
        while (pos < src.length && (src[pos] === " " || src[pos] === "\t")) pos++
      }
    }
  }

  /** The offset just past the `close` that balances the opener before `from`. Braces
   *  nest; brackets and parentheses do not, so `[a{]}b]` ends at the last bracket and
   *  a stray `}` inside an optional argument is ignored rather than closing it. */
  const balancedEnd = (from: number, close: string): number => {
    let level = 0
    for (let i = from; i < src.length; i++) {
      const ch = src[i]
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === "%") {
        while (i < src.length && src[i] !== "\n") i++
        continue
      }
      if (ch === "{") {
        level++
        continue
      }
      if (ch === "}") {
        if (level === 0) {
          if (close === "}") return i + 1
          continue
        }
        level--
        continue
      }
      if (ch === close && level === 0) return i + 1
    }
    return -1
  }

  const parseArgAt = (open: string, close: string): LatexArg | null => {
    if (src[pos] !== open) return null
    const start = pos
    const end = balancedEnd(pos + 1, close)
    if (end === -1) {
      diag("unterminated-argument", `an argument opened with ${open} never closes`, start)
      return null
    }
    pos = start + 1
    const nodes = parseNodes(end - 1)
    pos = end
    return { nodes, start, end, raw: src.slice(start + 1, end - 1) }
  }

  /** A mandatory argument: a braced group, or the next single token. */
  const parseMandatory = (): LatexArg | null => {
    skipInlineSpace()
    if (src[pos] === "{") return parseArgAt("{", "}")
    if (pos >= src.length) return null
    const start = pos
    if (src[pos] === "\\") {
      pos++
      if (pos < src.length && isLetter(src[pos] as string)) {
        while (pos < src.length && isLetter(src[pos] as string)) pos++
      } else pos++
    } else {
      pos += (src.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1
    }
    const raw = src.slice(start, pos)
    return { nodes: [{ type: "text", value: raw, start, end: pos }], start, end: pos, raw }
  }

  const parseSignature = (
    sig: string,
  ): { opt: LatexArg | null; paren: LatexArg | null; args: LatexArg[] } => {
    let opt: LatexArg | null = null
    let paren: LatexArg | null = null
    const args: LatexArg[] = []
    for (const kind of sig) {
      if (kind === "o") {
        const save = pos
        skipInlineSpace()
        const a = src[pos] === "[" ? parseArgAt("[", "]") : null
        if (a) {
          if (!opt) opt = a
          else args.push(a)
        } else pos = save
      } else if (kind === "p") {
        const save = pos
        skipInlineSpace()
        const a = src[pos] === "(" ? parseArgAt("(", ")") : null
        if (a) paren = a
        else pos = save
      } else if (kind === "m") {
        const save = pos
        const a = parseMandatory()
        if (a) args.push(a)
        else pos = save
      }
    }
    return { opt, paren, args }
  }

  /** `\newcommand{\name}[n][default]{body}` and friends: the name may be braced or bare,
   *  and `\def\name#1#2{body}` counts its parameter tokens. The body is kept raw. */
  const parseDefinition = (macro: string): { def: MacroDefinition; end: number } | null => {
    skipInlineSpace()
    if (src[pos] === "*") pos++
    skipInlineSpace()
    let name = ""
    if (src[pos] === "{") {
      const end = balancedEnd(pos + 1, "}")
      if (end === -1) return null
      name = src.slice(pos + 1, end - 1).trim()
      pos = end
    } else if (src[pos] === "\\") {
      let p = pos + 1
      if (isLetter(src[p] as string)) while (p < src.length && isLetter(src[p] as string)) p++
      else p++
      name = src.slice(pos, p)
      pos = p
    } else return null
    if (!name.startsWith("\\")) return null
    name = name.slice(1)
    let params = 0
    let defaultArg: string | null = null
    if (macro === "def") {
      while (src[pos] === "#") {
        pos += 2
        params++
      }
    } else {
      skipInlineSpace()
      if (src[pos] === "[") {
        const end = balancedEnd(pos + 1, "]")
        if (end === -1) return null
        params = Number.parseInt(src.slice(pos + 1, end - 1), 10) || 0
        pos = end
        skipInlineSpace()
        if (src[pos] === "[") {
          const dend = balancedEnd(pos + 1, "]")
          if (dend === -1) return null
          defaultArg = src.slice(pos + 1, dend - 1)
          pos = dend
        }
      }
    }
    skipInlineSpace()
    if (src[pos] !== "{") return null
    const end = balancedEnd(pos + 1, "}")
    if (end === -1) return null
    const body = src.slice(pos + 1, end - 1)
    pos = end
    return { def: { name, params, defaultArg, body }, end }
  }

  const readMath = (closer: string, start: number, display: boolean): MathNode => {
    const texStart = pos
    while (pos < src.length) {
      // The closer first: `\)` and `\]` start with the backslash an escape check would
      // otherwise step over.
      if (src.startsWith(closer, pos)) {
        const node: MathNode = {
          type: "math",
          display,
          env: null,
          tex: src.slice(texStart, pos),
          texStart,
          texEnd: pos,
          start,
          end: pos + closer.length,
        }
        pos += closer.length
        return node
      }
      pos += src[pos] === "\\" ? 2 : 1
    }
    diag("unterminated-math", `math opened at line ${lineAt(start)} never closes`, start)
    return {
      type: "math",
      display,
      env: null,
      tex: src.slice(texStart),
      texStart,
      texEnd: src.length,
      start,
      end: src.length,
    }
  }

  const readEnvironment = (start: number): LatexNode | null => {
    // `\begin` has been consumed; read {name}
    skipInlineSpace()
    if (src[pos] !== "{") return null
    const nameEnd = balancedEnd(pos + 1, "}")
    if (nameEnd === -1) return null
    const name = src.slice(pos + 1, nameEnd - 1).trim()
    pos = nameEnd
    const spec = ENV_SPECS[name] ?? {}
    const { opt, args } = parseSignature(spec.sig ?? "")
    const closer = `\\end{${name}}`
    if (spec.verbatim || spec.math) {
      const bodyStart = pos
      let bodyEnd = src.indexOf(closer, pos)
      let end: number
      if (bodyEnd === -1) {
        diag("unterminated-environment", `\\begin{${name}} never closes`, start)
        bodyEnd = src.length
        end = src.length
      } else end = bodyEnd + closer.length
      pos = end
      if (spec.math) {
        return {
          type: "math",
          display: true,
          env: name,
          tex: src.slice(bodyStart, bodyEnd),
          texStart: bodyStart,
          texEnd: bodyEnd,
          start,
          end,
        }
      }
      return {
        type: "verbatim",
        name,
        opt,
        args,
        text: src.slice(bodyStart, bodyEnd),
        textStart: bodyStart,
        textEnd: bodyEnd,
        start,
        end,
      }
    }
    const bodyStart = pos
    depth++
    if (depth > MAX_DEPTH) {
      diag("too-deep", "nesting deeper than 256 levels", start)
      depth--
      return null
    }
    envClose.at = null
    const body = parseNodes(src.length, name)
    depth--
    // parseNodes stops just past the \end that closed this environment (recording where
    // that \end began) or at EOF, in which case the body runs to the end of the source.
    const closedAt = takeEnvClose()
    if (!closedAt) diag("unterminated-environment", `\\begin{${name}} never closes`, start)
    return {
      type: "env",
      name,
      opt,
      args,
      body,
      bodyStart,
      bodyEnd: closedAt ? closedAt.start : pos,
      start,
      end: pos,
    }
  }

  /** Set by parseNodes when it returns because of an `\end`, read by readEnvironment. An
   *  object rather than a variable so the assignment inside the callee is visible to the
   *  caller's type narrowing. */
  const envClose: { at: { name: string; start: number } | null } = { at: null }
  const takeEnvClose = () => {
    const at = envClose.at
    envClose.at = null
    return at
  }

  /** Parse until `limit` or the `\end{closing}` of the environment being read. */
  const parseNodes = (limit: number, closing: string | null = null): LatexNode[] => {
    const nodes: LatexNode[] = []
    let textStart = -1
    const flushText = (at: number) => {
      if (textStart >= 0 && at > textStart)
        nodes.push({ type: "text", value: src.slice(textStart, at), start: textStart, end: at })
      textStart = -1
    }
    while (pos < limit) {
      const ch = src[pos] as string
      if (ch === "%") {
        flushText(pos)
        while (pos < limit && src[pos] !== "\n") pos++
        continue
      }
      if (ch === "\\") {
        flushText(pos)
        const start = pos
        pos++
        if (pos >= src.length) {
          nodes.push({ type: "text", value: "\\", start, end: pos })
          break
        }
        let name: string
        if (isLetter(src[pos] as string)) {
          const nameStart = pos
          while (pos < src.length && isLetter(src[pos] as string)) pos++
          name = src.slice(nameStart, pos)
          // TeX drops the space after a control word (`\LaTeX is` reads as `\LaTeX{}is`),
          // whether or not the macro takes arguments.
          if (name !== "begin" && name !== "end" && name !== "verb") skipInlineSpace()
        } else {
          name = src[pos] as string
          pos++
          if (name === "(") {
            nodes.push(readMath("\\)", start, false))
            continue
          }
          if (name === "[") {
            nodes.push(readMath("\\]", start, true))
            continue
          }
        }
        if (name === "begin") {
          const env = readEnvironment(start)
          if (env) nodes.push(env)
          else {
            diag("malformed-environment", "\\begin without an environment name", start)
            nodes.push({
              type: "macro",
              name,
              star: false,
              opt: null,
              paren: null,
              args: [],
              start,
              end: pos,
            })
          }
          continue
        }
        if (name === "end") {
          skipInlineSpace()
          if (src[pos] === "{") {
            const nameEnd = balancedEnd(pos + 1, "}")
            if (nameEnd !== -1) {
              const endName = src.slice(pos + 1, nameEnd - 1).trim()
              if (closing !== null) {
                // A mismatched \end closes the innermost environment anyway, so a typo cannot
                // swallow the rest of the document; say which name was expected.
                if (endName !== closing)
                  diag(
                    "mismatched-environment",
                    `\\end{${endName}} closes \\begin{${closing}}`,
                    start,
                  )
                envClose.at = { name: closing, start }
                pos = nameEnd
                return nodes
              }
              diag("stray-end", `\\end{${endName}} without a matching \\begin`, start)
              pos = nameEnd
              continue
            }
          }
          diag("malformed-environment", "\\end without an environment name", start)
          continue
        }
        if (name === "verb") {
          const delim = src[pos] === "*" ? src[pos + 1] : src[pos]
          const textStartAt = pos + (src[pos] === "*" ? 2 : 1)
          const close = delim === undefined ? -1 : src.indexOf(delim, textStartAt)
          if (delim !== undefined && close !== -1) {
            nodes.push({
              type: "verbatim",
              name: "verb",
              opt: null,
              args: [],
              text: src.slice(textStartAt, close),
              textStart: textStartAt,
              textEnd: close,
              start,
              end: close + 1,
            })
            pos = close + 1
            continue
          }
        }
        if (name === "par") {
          nodes.push({ type: "par", start, end: pos })
          continue
        }
        let star = false
        if (isLetter(name[0] as string) && src[pos] === "*") {
          star = true
          pos++
        }
        if (name === "def" || DEFINERS.has(name)) {
          const read = parseDefinition(name)
          if (read) {
            nodes.push({
              type: "macro",
              name,
              star,
              opt: null,
              paren: null,
              args: [],
              def: read.def,
              start,
              end: read.end,
            })
            continue
          }
        }
        const sig = MACRO_SIGNATURES[name]
        if (sig === undefined) {
          nodes.push({
            type: "macro",
            name,
            star,
            opt: null,
            paren: null,
            args: [],
            start,
            end: pos,
          })
          continue
        }
        const { opt, paren, args } = parseSignature(sig)
        nodes.push({ type: "macro", name, star, opt, paren, args, start, end: pos })
        continue
      }
      if (ch === "{") {
        flushText(pos)
        const start = pos
        const end = balancedEnd(pos + 1, "}")
        if (end === -1) {
          diag("unterminated-group", "a { never closes", start)
          pos++
          continue
        }
        depth++
        if (depth > MAX_DEPTH) {
          diag("too-deep", "nesting deeper than 256 levels", start)
          depth--
          pos = end
          continue
        }
        pos = start + 1
        const body = parseNodes(end - 1)
        depth--
        pos = end
        nodes.push({ type: "group", body, start, end })
        continue
      }
      if (ch === "}") {
        flushText(pos)
        diag("stray-brace", "a } without a matching {", pos)
        pos++
        continue
      }
      if (ch === "$") {
        flushText(pos)
        const start = pos
        if (src[pos + 1] === "$") {
          pos += 2
          nodes.push(readMath("$$", start, true))
        } else {
          pos++
          nodes.push(readMath("$", start, false))
        }
        continue
      }
      if (ch === "&") {
        flushText(pos)
        nodes.push({ type: "amp", start: pos, end: pos + 1 })
        pos++
        continue
      }
      if (ch === "\n" || ch === "\r") {
        // Two line breaks (with only blank space between) are a paragraph break.
        let look = pos + 1
        if (ch === "\r" && src[look] === "\n") look++
        let probe = look
        let breaks = 1
        while (probe < limit && isSpace(src[probe] as string)) {
          if (src[probe] === "\n") breaks++
          probe++
        }
        if (breaks >= 2) {
          flushText(pos)
          nodes.push({ type: "par", start: pos, end: probe })
          pos = probe
          continue
        }
      }
      if (textStart < 0) textStart = pos
      pos++
    }
    flushText(Math.min(pos, limit))
    return nodes
  }

  const nodes = parseNodes(src.length)
  return { source: src, nodes, diagnostics }
}

/** Flatten the visible text of nodes without any rendering (used for titles, labels). */
export const plainTextOf = (nodes: LatexNode[]): string => {
  let out = ""
  for (const n of nodes) {
    if (n.type === "text") out += n.value
    else if (n.type === "group") out += plainTextOf(n.body)
    else if (n.type === "env") out += plainTextOf(n.body)
    else if (n.type === "macro") {
      if (n.name === " " || n.name === "," || n.name === "quad" || n.name === "qquad") out += " "
      else if (n.name === "\\" || n.name === "newline") out += " "
      for (const a of n.args) out += plainTextOf(a.nodes)
    } else if (n.type === "math") out += n.tex
    else if (n.type === "verbatim") out += n.text
    else if (n.type === "par" || n.type === "amp") out += " "
  }
  return out.replace(/\s+/g, " ").trim()
}
