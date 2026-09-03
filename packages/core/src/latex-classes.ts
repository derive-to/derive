/**
 * Class profiles for the LaTeX renderer: what `\documentclass` and its options mean for
 * citations, float labels and the title block, plus the top-matter collector and the
 * `\maketitle` rendering for acmart (ACM SIGGRAPH and journals), the CVPR author kit
 * (`article` + `\usepackage{cvpr}`) and a generic fallback.
 *
 * acmart puts `\author`, `\affiliation`, `\ccsdesc`, `abstract` and `teaserfigure` in
 * the body before `\maketitle` and typesets them all at `\maketitle`; the collector
 * reads them wherever they are so the page shows the paper's front matter in the order
 * the PDF would, not the order the macros were typed.
 */

import { attr, type ClassProfile, READONLY_ATTR, type RenderContext } from "./latex-emit"
import {
  type EnvNode,
  type LatexArg,
  type LatexNode,
  type MacroNode,
  plainTextOf,
} from "./latex-parse"

const ACM_FORMATS = new Set([
  "manuscript",
  "acmsmall",
  "acmlarge",
  "acmtog",
  "sigconf",
  "sigplan",
  "sigchi",
  "sigchi-a",
  "siggraph",
  "acmengage",
  "acmcp",
])
const ACM_JOURNAL_FORMATS = new Set(["manuscript", "acmsmall", "acmlarge", "acmtog", "acmcp"])

const optionsOf = (macro: MacroNode): string[] =>
  (macro.opt?.raw ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)

/** Read the class and the options that change how the document reads. */
export const detectProfile = (nodes: LatexNode[]): ClassProfile => {
  let documentClass = "article"
  let classOptions: string[] = []
  let cvprOptions: string[] | null = null
  let citeStyle: "numeric" | "authoryear" | null = null
  const visit = (list: LatexNode[]) => {
    for (const n of list) {
      if (n.type === "macro") {
        if (n.name === "documentclass" && n.args[0]) {
          documentClass = n.args[0].raw.trim()
          classOptions = optionsOf(n)
        } else if ((n.name === "usepackage" || n.name === "RequirePackage") && n.args[0]) {
          const names = n.args[0].raw.split(",").map((s) => s.trim())
          if (names.includes("cvpr")) cvprOptions = optionsOf(n)
        } else if (n.name === "citestyle" && n.args[0]) {
          const v = n.args[0].raw.trim()
          if (v === "acmauthoryear") citeStyle = "authoryear"
          else if (v === "acmnumeric") citeStyle = "numeric"
        } else if (n.name === "setcitestyle" && n.args[0]) {
          const v = n.args[0].raw
          if (/authoryear/.test(v)) citeStyle = "authoryear"
          else if (/numbers/.test(v)) citeStyle = "numeric"
        }
      } else if (n.type === "env" && n.name === "document") visit(n.body)
    }
  }
  visit(nodes)
  if (documentClass === "acmart") {
    let format = classOptions.find((o) => ACM_FORMATS.has(o)) ?? "manuscript"
    if (format === "siggraph" || format === "sigchi") format = "sigconf"
    const journal = ACM_JOURNAL_FORMATS.has(format)
    return {
      kind: "acm",
      documentClass,
      format,
      journal,
      anonymous: classOptions.includes("anonymous"),
      review: classOptions.includes("review"),
      citeStyle: citeStyle ?? (journal ? "authoryear" : "numeric"),
      compressCitations: false,
      bibStyle: "acm",
    }
  }
  if (cvprOptions !== null) {
    const opts = cvprOptions as string[]
    // The author kit defaults to review mode; `final` is the camera-ready switch.
    const review = !opts.includes("final") && !opts.includes("rebuttal")
    return {
      kind: "cvpr",
      documentClass,
      format: null,
      journal: false,
      anonymous: review,
      review,
      citeStyle: "numeric",
      compressCitations: true,
      bibStyle: "ieeenat",
    }
  }
  return {
    kind: "generic",
    documentClass,
    format: null,
    journal: false,
    anonymous: false,
    review: false,
    citeStyle: citeStyle ?? "numeric",
    compressCitations: false,
    bibStyle: "plain",
  }
}

export interface Affiliation {
  parts: { name: string; arg: LatexArg }[]
  start: number
  end: number
}

export interface AuthorBlock {
  name: LatexArg
  macro: MacroNode
  orcid: LatexArg | null
  emails: LatexArg[]
  affiliations: Affiliation[]
  /** Indexes into `TopMatter.authorNotes`. */
  notes: number[]
}

export interface TopMatter {
  title: MacroNode | null
  subtitle: MacroNode | null
  authors: AuthorBlock[]
  /** `\author{...}` of non-acmart classes, rendered as a block with `\and` columns. */
  authorsRaw: MacroNode | null
  date: MacroNode | null
  authorNotes: MacroNode[]
  conference: MacroNode | null
  journal: string | null
  volume: string | null
  number: string | null
  article: string | null
  month: string | null
  year: string | null
  doi: string | null
  isbn: string | null
  copyright: string | null
  copyrightYear: string | null
  submissionId: string | null
  nonacm: boolean
  ccs: MacroNode[]
  keywords: MacroNode | null
  abstract: EnvNode | null
  teaser: EnvNode | null
  paperId: string | null
  confName: string | null
  confYear: string | null
  maketitle: MacroNode | null
}

const AFFILIATION_PARTS = new Set([
  "department",
  "institution",
  "streetaddress",
  "city",
  "state",
  "postcode",
  "country",
])

const TOP_MATTER_MACROS = new Set([
  "title",
  "subtitle",
  "author",
  "orcid",
  "email",
  "affiliation",
  "additionalaffiliation",
  "authornote",
  "authornotemark",
  "titlenote",
  "subtitlenote",
  "authorsaddresses",
  "acmConference",
  "acmBooktitle",
  "acmJournal",
  "acmVolume",
  "acmNumber",
  "acmArticle",
  "acmArticleSeq",
  "acmMonth",
  "acmYear",
  "copyrightyear",
  "acmDOI",
  "acmISBN",
  "acmPrice",
  "acmSubmissionID",
  "acmArticleType",
  "acmCodeLink",
  "acmDataLink",
  "acmBadgeR",
  "acmBadgeL",
  "startPage",
  "setcopyright",
  "setcctype",
  "settopmatter",
  "citestyle",
  "setcitestyle",
  "received",
  "ccsdesc",
  "keywords",
  "date",
  "paperID",
  "cvprPaperID",
  "confName",
  "confYear",
  ...AFFILIATION_PARTS,
])

/** Macros the collector consumes; the walker prints nothing for them. */
export const isTopMatterMacro = (name: string): boolean => TOP_MATTER_MACROS.has(name)

const rawOf = (m: MacroNode): string | null => (m.args[0] ? plainTextOf(m.args[0].nodes) : null)

const readAffiliation = (arg: LatexArg): Affiliation => {
  const parts: Affiliation["parts"] = []
  const visit = (nodes: LatexNode[]) => {
    for (const n of nodes) {
      if (n.type === "macro" && AFFILIATION_PARTS.has(n.name) && n.args[0])
        parts.push({ name: n.name, arg: n.args[0] })
      else if (n.type === "group") visit(n.body)
    }
  }
  visit(arg.nodes)
  return { parts, start: arg.start, end: arg.end }
}

/** Read the title block wherever the class allows it: the preamble, the body before
 *  `\maketitle`, and groups (acmart authors are often wrapped in braces). */
export const collectTopMatter = (nodes: LatexNode[], profile: ClassProfile): TopMatter => {
  const top: TopMatter = {
    title: null,
    subtitle: null,
    authors: [],
    authorsRaw: null,
    date: null,
    authorNotes: [],
    conference: null,
    journal: null,
    volume: null,
    number: null,
    article: null,
    month: null,
    year: null,
    doi: null,
    isbn: null,
    copyright: null,
    copyrightYear: null,
    submissionId: null,
    nonacm: false,
    ccs: [],
    keywords: null,
    abstract: null,
    teaser: null,
    paperId: null,
    confName: null,
    confYear: null,
    maketitle: null,
  }
  const current = (): AuthorBlock | null => top.authors[top.authors.length - 1] ?? null
  const visit = (list: LatexNode[]) => {
    for (const n of list) {
      if (n.type === "env") {
        if (n.name === "document") visit(n.body)
        else if (n.name === "abstract" && !top.abstract) top.abstract = n
        else if (n.name === "teaserfigure" && !top.teaser) top.teaser = n
        continue
      }
      if (n.type === "group") {
        visit(n.body)
        continue
      }
      if (n.type !== "macro") continue
      const m = n
      if (m.def) {
        if (m.def.name === "confName") top.confName = m.def.body.trim()
        else if (m.def.name === "confYear") top.confYear = m.def.body.trim()
        else if (m.def.name === "cvprPaperID") top.paperId = m.def.body.trim()
        continue
      }
      switch (m.name) {
        case "documentclass":
          if (optionsOf(m).includes("nonacm")) top.nonacm = true
          break
        case "title":
          if (!top.title) top.title = m
          break
        case "subtitle":
          top.subtitle = m
          break
        case "author":
          if (profile.kind === "acm" && m.args[0])
            top.authors.push({
              name: m.args[0],
              macro: m,
              orcid: null,
              emails: [],
              affiliations: [],
              notes: [],
            })
          else if (!top.authorsRaw) top.authorsRaw = m
          break
        case "orcid": {
          const a = current()
          if (a && m.args[0]) a.orcid = m.args[0]
          break
        }
        case "email": {
          const a = current()
          if (a && m.args[0]) a.emails.push(m.args[0])
          break
        }
        case "affiliation":
        case "additionalaffiliation": {
          const a = current()
          if (a && m.args[0]) a.affiliations.push(readAffiliation(m.args[0]))
          break
        }
        case "authornote": {
          top.authorNotes.push(m)
          const a = current()
          if (a) a.notes.push(top.authorNotes.length - 1)
          break
        }
        case "authornotemark": {
          const a = current()
          const idx = Number.parseInt(m.opt?.raw ?? "", 10)
          if (a && Number.isFinite(idx) && idx >= 1) a.notes.push(idx - 1)
          break
        }
        case "date":
          top.date = m
          break
        case "acmConference":
          top.conference = m
          break
        case "acmJournal":
          top.journal = rawOf(m)
          break
        case "acmVolume":
          top.volume = rawOf(m)
          break
        case "acmNumber":
          top.number = rawOf(m)
          break
        case "acmArticle":
          top.article = rawOf(m)
          break
        case "acmMonth":
          top.month = rawOf(m)
          break
        case "acmYear":
          top.year = rawOf(m)
          break
        case "copyrightyear":
          top.copyrightYear = rawOf(m)
          break
        case "acmDOI":
          top.doi = rawOf(m)
          break
        case "acmISBN":
          top.isbn = rawOf(m)
          break
        case "setcopyright":
          top.copyright = rawOf(m)
          break
        case "acmSubmissionID":
          top.submissionId = rawOf(m)
          break
        case "ccsdesc":
          top.ccs.push(m)
          break
        case "keywords":
          top.keywords = m
          break
        case "paperID":
          top.paperId = rawOf(m)
          break
        case "confName":
          top.confName = rawOf(m)
          break
        case "confYear":
          top.confYear = rawOf(m)
          break
        case "maketitle":
          if (!top.maketitle) top.maketitle = m
          break
        default:
          break
      }
    }
  }
  visit(nodes)
  return top
}

const JOURNAL_NAMES: Record<string, string> = {
  TOG: "ACM Trans. Graph.",
  TOCHI: "ACM Trans. Comput.-Hum. Interact.",
  TOMS: "ACM Trans. Math. Softw.",
  JACM: "J. ACM",
  CSUR: "ACM Comput. Surv.",
  TOPLAS: "ACM Trans. Program. Lang. Syst.",
  TOSEM: "ACM Trans. Softw. Eng. Methodol.",
  TACO: "ACM Trans. Archit. Code Optim.",
  TECS: "ACM Trans. Embed. Comput. Syst.",
  TOCS: "ACM Trans. Comput. Syst.",
  TODS: "ACM Trans. Database Syst.",
  TOIS: "ACM Trans. Inf. Syst.",
  TIST: "ACM Trans. Intell. Syst. Technol.",
  TKDD: "ACM Trans. Knowl. Discov. Data",
  TOMM: "ACM Trans. Multimedia Comput. Commun. Appl.",
  TOSN: "ACM Trans. Sen. Netw.",
  TWEB: "ACM Trans. Web",
  TALG: "ACM Trans. Algorithms",
  TOIT: "ACM Trans. Internet Technol.",
  TIIS: "ACM Trans. Interact. Intell. Syst.",
  TOCE: "ACM Trans. Comput. Educ.",
  TEAC: "ACM Trans. Econ. Comput.",
  TOPC: "ACM Trans. Parallel Comput.",
  TRETS: "ACM Trans. Reconfigurable Technol. Syst.",
  THRI: "ACM Trans. Hum.-Robot Interact.",
  TIOT: "ACM Trans. Internet Things",
  TOMACS: "ACM Trans. Model. Comput. Simul.",
  TSC: "ACM Trans. Soc. Comput.",
  TQC: "ACM Trans. Quantum Comput.",
  JETC: "ACM J. Emerg. Technol. Comput. Syst.",
  JEA: "ACM J. Exp. Algorithmics",
  JOCCH: "ACM J. Comput. Cult. Herit.",
  JDIQ: "ACM J. Data Inf. Qual.",
  PACMHCI: "Proc. ACM Hum.-Comput. Interact.",
  PACMPL: "Proc. ACM Program. Lang.",
  PACMCGIT: "Proc. ACM Comput. Graph. Interact. Tech.",
  POMACS: "Proc. ACM Meas. Anal. Comput. Syst.",
  IMWUT: "Proc. ACM Interact. Mob. Wearable Ubiquitous Technol.",
}

const MONTH_NAMES = [
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

const RIGHTS: Record<string, string> = {
  acmcopyright: "Association for Computing Machinery.",
  acmlicensed: "Copyright held by the owner/author(s). Publication rights licensed to ACM.",
  rightsretained: "Copyright held by the owner/author(s).",
  usgov:
    "This paper is authored by an employee(s) of the United States Government and is in the public domain.",
  usgovmixed: "Association for Computing Machinery.",
  cagov: "Crown in Right of Canada.",
  cagovmixed: "Association for Computing Machinery.",
  cc: "Copyright held by the owner/author(s). This work is licensed under a Creative Commons license.",
  iw3c2w3:
    "This paper is published under the Creative Commons Attribution 4.0 International (CC-BY 4.0) license.",
  iw3c2wg:
    "This paper is published under the Creative Commons Attribution 4.0 International (CC-BY 4.0) license.",
}

const NOTE_MARKS = ["*", "†", "‡", "§", "¶", "‖"]

/** Render the front matter at `\maketitle`. Made-up text (the venue line, "Anonymous
 *  Author(s)") is attributed to the `\maketitle` macro; the title and names keep their
 *  own source spans so a comment on the title lands on `\title{...}`. */
export const renderMakeTitle = (ctx: RenderContext, top: TopMatter, at: MacroNode): void => {
  const { out, profile } = ctx
  const say = (text: string) => out.entity(text, at.start, at.end)
  const inlineArg = (arg: LatexArg | undefined | null) => {
    if (!arg) return
    ctx.inlineDepth++
    ctx.inline(arg.nodes)
    ctx.inlineDepth--
  }
  ctx.closeParagraph(at.start)
  if (profile.review && profile.kind === "cvpr") {
    out.markup(`<p class="derive-review-band"${READONLY_ATTR}>`, at.start)
    say(
      `${top.confName ?? "CVPR"} ${top.confYear ?? ""} Submission #${top.paperId ?? "*****"}. CONFIDENTIAL REVIEW COPY. DO NOT DISTRIBUTE.`,
    )
    out.markup("</p>")
  } else if (profile.review) {
    out.markup(`<p class="derive-review-band"${READONLY_ATTR}>`, at.start)
    say("Unpublished working draft. Not for distribution.")
    out.markup("</p>")
  }
  out.markup('<header class="derive-titlepage">', at.start)
  out.markup('<h1 class="derive-title">')
  ctx.counters.titleStart = out.text.length
  if (top.title) inlineArg(top.title.args[top.title.args.length - 1])
  else say("Untitled")
  ctx.counters.titleEnd = out.text.length
  out.markup("</h1>")
  if (top.subtitle) {
    out.markup('<p class="derive-subtitle">')
    inlineArg(top.subtitle.args[0])
    out.markup("</p>")
  }
  if (profile.anonymous) {
    out.markup(
      `<div class="derive-authors"${READONLY_ATTR}><div class="derive-author"><span class="derive-author-name">`,
    )
    say(
      profile.kind === "cvpr"
        ? `Anonymous ${top.confName ?? "CVPR"} submission`
        : "Anonymous Author(s)",
    )
    out.markup("</span></div></div>")
    if (profile.kind === "acm" && top.submissionId) {
      out.markup(`<p class="derive-submission-id"${READONLY_ATTR}>`)
      say(`Submission Id: ${top.submissionId}`)
      out.markup("</p>")
    }
  } else if (profile.kind === "acm") {
    out.markup(`<div class="derive-authors"${READONLY_ATTR}>`)
    for (const author of top.authors) {
      out.markup('<div class="derive-author">', author.macro.start)
      out.markup('<span class="derive-author-name">')
      inlineArg(author.name)
      out.markup("</span>")
      for (const idx of author.notes) {
        out.markup('<sup class="derive-author-mark">')
        out.entity(
          NOTE_MARKS[idx % NOTE_MARKS.length] as string,
          author.macro.start,
          author.macro.end,
        )
        out.markup("</sup>")
      }
      if (author.orcid) {
        const id = plainTextOf(author.orcid.nodes).trim()
        out.markup(
          `<a class="derive-orcid" href="${attr(`https://orcid.org/${id}`)}" title="ORCID">`,
          author.orcid.start,
        )
        inlineArg(author.orcid)
        out.markup("</a>")
      }
      for (const aff of author.affiliations) {
        out.markup('<span class="derive-affiliation">', aff.start)
        let first = true
        for (const part of aff.parts) {
          if (part.name === "streetaddress" || part.name === "postcode") continue
          if (!first) out.entity(", ", part.arg.start, part.arg.start)
          first = false
          inlineArg(part.arg)
        }
        out.markup("</span>", aff.end)
      }
      for (const email of author.emails) {
        const address = plainTextOf(email.nodes).trim()
        out.markup(`<a class="derive-email" href="${attr(`mailto:${address}`)}">`, email.start)
        inlineArg(email)
        out.markup("</a>", email.end)
      }
      out.markup("</div>", author.macro.end)
    }
    out.markup("</div>")
    if (top.authorNotes.length) {
      out.markup(`<div class="derive-author-notes"${READONLY_ATTR}>`)
      top.authorNotes.forEach((note, idx) => {
        out.markup("<p>", note.start)
        out.entity(`${NOTE_MARKS[idx % NOTE_MARKS.length]} `, note.start, note.start)
        inlineArg(note.args[0])
        out.markup("</p>", note.end)
      })
      out.markup("</div>")
    }
  } else if (top.authorsRaw?.args[0]) {
    // `\author{A \\ Inst \and B \\ Inst}`: one column per \and, line breaks kept.
    const columns: LatexNode[][] = [[]]
    for (const n of top.authorsRaw.args[0].nodes) {
      if (n.type === "macro" && n.name === "and") columns.push([])
      else (columns[columns.length - 1] as LatexNode[]).push(n)
    }
    out.markup(`<div class="derive-authors"${READONLY_ATTR}>`, top.authorsRaw.start)
    for (const col of columns) {
      out.markup('<div class="derive-author">')
      ctx.inlineDepth++
      ctx.inline(col)
      ctx.inlineDepth--
      out.markup("</div>")
    }
    out.markup("</div>", top.authorsRaw.end)
    if (top.date?.args[0]) {
      out.markup(`<p class="derive-date"${READONLY_ATTR}>`, top.date.start)
      inlineArg(top.date.args[0])
      out.markup("</p>", top.date.end)
    }
  }
  if (profile.kind === "acm" && !top.nonacm) renderAcmVenue(ctx, top, at)
  out.markup("</header>")
  if (profile.kind === "acm") {
    if (top.abstract) renderAbstract(ctx, top.abstract)
    if (top.ccs.length) {
      out.markup(`<section class="derive-ccs"${READONLY_ATTR}>`, at.start)
      out.markup(`<h2 class="derive-frontmatter-title"${READONLY_ATTR}>`)
      say("CCS Concepts")
      out.markup("</h2>")
      for (const c of top.ccs) {
        const arg = c.args[0]
        if (!arg) continue
        const parts = plainTextOf(arg.nodes)
          .split("~")
          .map((p) => p.trim())
          .filter(Boolean)
        const weight = Number.parseInt(c.opt?.raw ?? "500", 10)
        out.markup("<p>", c.start)
        out.entity(
          `• ${parts.slice(0, -1).join(" → ")}${parts.length > 1 ? " → " : ""}`,
          arg.start,
          arg.end,
        )
        const leaf = parts[parts.length - 1] ?? ""
        const tag = weight >= 500 ? "strong" : weight >= 300 ? "em" : "span"
        out.markup(`<${tag}>`)
        out.entity(leaf, arg.start, arg.end)
        out.markup(`</${tag}>`)
        out.entity(";", arg.start, arg.end)
        out.markup("</p>", c.end)
      }
      out.markup("</section>")
    }
    if (top.keywords?.args[0]) {
      out.markup('<section class="derive-keywords">', top.keywords.start)
      out.markup(`<h2 class="derive-frontmatter-title"${READONLY_ATTR}>`)
      say("Keywords")
      out.markup("</h2><p>")
      inlineArg(top.keywords.args[0])
      out.markup("</p></section>", top.keywords.end)
    }
    if (top.teaser) {
      ctx.counters.hoisting = 1
      ctx.walk([top.teaser])
      ctx.counters.hoisting = 0
    }
  }
}

const renderAcmVenue = (ctx: RenderContext, top: TopMatter, at: MacroNode): void => {
  const { out } = ctx
  const say = (text: string) => out.entity(text, at.start, at.end)
  if (top.journal || (ctx.profile.journal && (top.volume || top.article))) {
    const name = JOURNAL_NAMES[top.journal ?? ""] ?? top.journal ?? "ACM Journal"
    const month = top.month ? MONTH_NAMES[Number.parseInt(top.month, 10) - 1] : null
    const bits = [
      name,
      top.volume ? `Vol. ${top.volume}` : null,
      top.number ? `No. ${top.number}` : null,
      top.article ? `Article ${top.article}` : null,
    ].filter(Boolean)
    out.markup(`<p class="derive-venue"${READONLY_ATTR}>`, at.start)
    say(
      `${bits.join(", ")}.${month || top.year ? ` Publication date: ${[month, top.year].filter(Boolean).join(" ")}.` : ""}`,
    )
    out.markup("</p>")
  } else if (top.conference) {
    const [name, date, venue] = top.conference.args.map((a) => plainTextOf(a.nodes).trim())
    const short = top.conference.opt ? plainTextOf(top.conference.opt.nodes).trim() : null
    out.markup(`<p class="derive-venue"${READONLY_ATTR}>`, top.conference.start)
    out.entity(
      [short ?? name, date, venue].filter(Boolean).join(", "),
      top.conference.start,
      top.conference.end,
    )
    out.markup("</p>", top.conference.end)
  }
  const rights = top.copyright && top.copyright !== "none" ? RIGHTS[top.copyright] : null
  const year = top.copyrightYear ?? top.year
  const lines: string[] = []
  if (rights) lines.push(`© ${year ? `${year} ` : ""}${rights}`)
  if (top.isbn) lines.push(`ACM ISBN ${top.isbn}`)
  if (!lines.length && !top.doi) return
  out.markup(`<p class="derive-rights"${READONLY_ATTR}>`, at.start)
  say(lines.join(" "))
  if (top.doi) {
    const url = /^https?:\/\//.test(top.doi) ? top.doi : `https://doi.org/${top.doi}`
    if (lines.length) say(" ")
    out.markup(`<a href="${attr(url)}">`)
    say(url)
    out.markup("</a>")
  }
  out.markup("</p>")
}

/** The abstract as a titled section (acmart renders it under the byline; other classes
 *  render it where it stands). */
export const renderAbstract = (ctx: RenderContext, env: EnvNode): void => {
  const { out } = ctx
  ctx.closeParagraph(env.start)
  out.markup('<section class="derive-abstract">', env.start)
  out.markup(`<h2 class="derive-frontmatter-title"${READONLY_ATTR}>`)
  out.entity("Abstract", env.start, env.bodyStart)
  out.markup("</h2>")
  ctx.walk(env.body)
  ctx.closeParagraph(env.bodyEnd)
  out.markup("</section>", env.end)
}

/** Stylesheet layered over the document shell's PAGE_CSS. Fonts are named the way the
 *  classes name them (Libertine for acmart, Times for CVPR) with system fallbacks; no
 *  font files ship with the page. */
export const LATEX_CSS = `
  main{max-width:780px}
  .derive-paper{font-family:"Linux Libertine O","Libertinus Serif","Liberation Serif",Georgia,"Times New Roman",serif;
    font-size:17px;line-height:1.6}
  .derive-paper-cvpr{font-family:"Times New Roman",Times,"Nimbus Roman","Liberation Serif",serif}
  .derive-paper h1,.derive-paper h2,.derive-paper h3,.derive-paper h4{font-family:inherit;letter-spacing:0}
  .derive-paper-acm h1,.derive-paper-acm h2,.derive-paper-acm h3{font-family:"Linux Biolinum O","Libertinus Sans","Liberation Sans",system-ui,sans-serif}
  .derive-review-band{margin:0 0 1.5em;padding:.5em .8em;border:1px solid var(--line);border-radius:8px;
    font-size:.8em;text-align:center;color:var(--muted);letter-spacing:.02em}
  .derive-titlepage{text-align:center;margin-bottom:2.2em}
  .derive-title{font-size:2em;font-weight:600;line-height:1.2;margin:0 0 .4em}
  .derive-subtitle{font-size:1.15em;color:var(--body);margin:0 0 1em}
  .derive-authors{display:flex;flex-wrap:wrap;justify-content:center;gap:1em 2.4em;margin:1.2em 0 .6em}
  .derive-author{display:flex;flex-direction:column;align-items:center;font-size:.95em;line-height:1.45}
  .derive-author-name{color:var(--ink);font-weight:500;font-size:1.05em}
  .derive-author-mark{font-size:.7em}
  .derive-affiliation,.derive-email,.derive-orcid{color:var(--muted);font-size:.9em}
  .derive-orcid{text-decoration:none;font-size:.75em}
  .derive-author-notes{font-size:.85em;color:var(--muted);text-align:left;max-width:520px;margin:0 auto}
  .derive-author-notes p{margin:.2em 0}
  .derive-venue,.derive-rights,.derive-date,.derive-submission-id{font-size:.85em;color:var(--muted);margin:.4em 0}
  .derive-rights a{color:inherit}
  .derive-abstract,.derive-ccs,.derive-keywords{margin:1.6em 0}
  .derive-abstract{font-size:.95em}
  .derive-frontmatter-title{font-size:1em;text-transform:uppercase;letter-spacing:.08em;margin:0 0 .4em;color:var(--muted)}
  .derive-secnum{margin-right:.55em;color:var(--muted);font-weight:500}
  .derive-runin{font-weight:600;color:var(--ink);margin-right:.4em}
  .derive-float{margin:2em 0;text-align:center}
  .derive-float img{display:inline-block;margin:0 auto;border-radius:0;box-shadow:none}
  .derive-subfloat{display:inline-block;vertical-align:top;margin:.4em .6em}
  .derive-subfloat figcaption{text-align:center}
  figcaption{font-size:.9em;color:var(--body);margin:.8em auto 0;text-align:left;max-width:640px;line-height:1.5}
  .derive-caption-label{color:var(--ink);font-weight:600}
  .derive-table figcaption{margin:0 auto .8em}
  .derive-tabular{width:auto;margin:0 auto;font-size:.9em;border-collapse:collapse}
  .derive-tabular th,.derive-tabular td{padding:5px 12px;border:0;text-align:left;vertical-align:top}
  .derive-tabular thead tr:first-child th{border-top:1.5px solid var(--ink)}
  .derive-tabular thead tr:last-child th{border-bottom:1px solid var(--ink)}
  .derive-tabular tbody tr:last-child td{border-bottom:1.5px solid var(--ink)}
  .derive-tabular .derive-rule-above td,.derive-tabular .derive-rule-above th{border-top:1px solid var(--ink)}
  .derive-tabular thead .derive-rule-above:first-child th{border-top:1.5px solid var(--ink)}
  .derive-dynamic:not(table){text-align:center}
  .derive-figure-empty,.derive-figure-missing{display:inline-block;padding:1.4em 1.8em;border:1px dashed var(--line);
    border-radius:8px;color:var(--muted);font-size:.85em;font-family:ui-monospace,Menlo,Consolas,monospace}
  .derive-math-display{position:relative;display:flex;justify-content:center;align-items:center;
    margin:1.2em 0;overflow-x:auto;padding-right:3.5em}
  .derive-eqnum{position:absolute;right:0;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.9em}
  .derive-math[data-derive-math]:empty::before{content:attr(data-tex);font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:.85em;color:var(--muted)}
  .derive-theorem{margin:1.4em 0}
  .derive-theorem-head{font-weight:600;color:var(--ink)}
  .derive-theorem-body{font-style:italic}
  .derive-proof-end{float:right;margin-left:1em}
  .derive-footnote{display:block;font-size:.85em;color:var(--muted);border-left:2px solid var(--line);
    padding-left:.8em;margin:.6em 0}
  .derive-footnote-mark{font-size:.75em;vertical-align:super;line-height:0}
  .derive-cite,.derive-ref{text-decoration:none;color:var(--ink)}
  .derive-cite:hover,.derive-ref:hover{text-decoration:underline}
  .derive-references ol{padding-left:2.4em}
  .derive-references li{margin:.7em 0;font-size:.92em;line-height:1.5}
  .derive-references li::marker{color:var(--muted)}
  .derive-reference-label{display:inline-block;min-width:2.2em;color:var(--muted)}
  .derive-unknown{color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
  .derive-unsupported{font-size:.8em}
  .derive-minipage{display:inline-block;vertical-align:top;margin:.4em .6em;text-align:left}
  .derive-center{text-align:center}
  .derive-flushright{text-align:right}
  .derive-sc{font-variant:small-caps}
  .derive-tt{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.9em}
  .derive-sf{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .derive-small{font-size:.85em}
  .derive-large{font-size:1.2em}
  .derive-underline{text-decoration:underline}
  .derive-strike{text-decoration:line-through}
  .derive-env{margin:1.2em 0}
  .derive-appendix-title{margin-top:3em}
  @media(max-width:640px){.derive-paper{font-size:16px}.derive-math-display{padding-right:2.5em}}
`
