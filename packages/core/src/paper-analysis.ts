/**
 * A paper's implementation analysis: the map from what an imported paper claims to the code
 * that carries it out.
 *
 * An imported arXiv paper can carry its implementation, and an agent that reads both can say
 * which files, symbols and lines realise each contribution, and where the code departs from
 * the paper. That investigation is expensive and worth keeping, so it is published as data an
 * agent writes once and keeps current: validated here, shown to people on the paper's Context,
 * and read by the next agent before it maps the paper again.
 *
 * It refers to code and never quotes it. A repository's files are for agents to read; a person
 * follows a reference to the repository's own host. So the prose fields take inline markdown
 * only, and a code block, HTML or a long code span is refused rather than published.
 */

export const PAPER_ANALYSIS_SCHEMA = "derive.paper-analysis/v1"
/** The analysis itself, inside its bundle. */
export const PAPER_ANALYSIS_FILE = "/derive.paper-analysis.json"
/** The page Derive renders from it for people, and the bundle's entry. */
export const PAPER_ANALYSIS_PAGE = "/index.md"
export const PAPER_ANALYSIS_MAX_BYTES = 150 * 1024

export type AnalysisStatus = "implemented" | "partial" | "differs" | "not_found"
export const ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  "implemented",
  "partial",
  "differs",
  "not_found",
]

/** A place in the paper: a page, optionally `page#slug` for one heading's part (the grammar
 *  `read` takes), and optionally a `\label` inside it. */
export interface AnalysisPaperRef {
  section: string
  label?: string
}

/** A place in the code: a repository-relative path, optionally a symbol and a line range. */
export interface AnalysisCodeRef {
  path: string
  symbol?: string
  lines?: string
}

export interface AnalysisDetail {
  id: string
  title: string
  paper: AnalysisPaperRef[]
  code: AnalysisCodeRef[]
  status: AnalysisStatus
  notes?: string
}

export interface AnalysisContribution {
  id: string
  title: string
  claim: string
  paper: AnalysisPaperRef[]
  details: AnalysisDetail[]
}

export interface AnalysisUnmapped {
  id: string
  path: string
  symbol?: string
  lines?: string
  notes: string
}

export interface AnalysisQuestion {
  id: string
  question: string
}

export interface AnalysisRemoval {
  id: string
  reason: string
}

export interface PaperAnalysis {
  schema: typeof PAPER_ANALYSIS_SCHEMA
  /** The Context this is the analysis of. */
  context: string
  /** The version of the analysis an update was made from; null when creating it. */
  based_on: number | null
  /** What it was made against, so a reader can tell when the paper or the code moved on. */
  paper: { short_id: string; arxiv_version: number | null }
  implementation: { repository: string; commit: string | null }
  summary: string
  contributions: AnalysisContribution[]
  /** Code the paper does not describe that a reader of the method should know about. */
  unmapped: AnalysisUnmapped[]
  open_questions: AnalysisQuestion[]
  /** Ids this version drops, each with why. Only this version's: a later one starts empty. */
  removed: AnalysisRemoval[]
}

export type PaperAnalysisParse =
  | { ok: true; analysis: PaperAnalysis }
  | { ok: false; errors: string[] }

const MAX = {
  contributions: 30,
  details: 400,
  detailsPerContribution: 60,
  codeRefs: 20,
  paperRefs: 10,
  files: 150,
  unmapped: 50,
  questions: 30,
  removed: 400,
  title: 200,
  prose: 1200,
  summary: 2000,
  question: 600,
  reason: 300,
  symbol: 120,
  section: 200,
  label: 100,
  path: 500,
  codeSpan: 80,
  errors: 25,
} as const

const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/
const LINES = /^(\d+)(?:-(\d+))?$/
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

/** Why prose is not inline markdown, or null when it is. A fenced or indented block, HTML, a
 *  heading, a table or a long code span would carry code, or a page layout, into a field that
 *  says what the code does. */
const proseProblem = (text: string): string | null => {
  if (/```|~~~/.test(text)) return "a fenced code block"
  const lines = text.split("\n")
  for (const [i, line] of lines.entries())
    if (
      (i === 0 || lines[i - 1]?.trim() === "") &&
      /^(?: {4}|\t)\S/.test(line) &&
      !/^\s+(?:[-*+]|\d+[.)])\s/.test(line)
    )
      return "an indented code block"
  for (const span of text.matchAll(/`([^`\n]*)`/g))
    if ((span[1]?.length ?? 0) > MAX.codeSpan) return `a code span over ${MAX.codeSpan} characters`
  const outsideSpans = text.replace(/`[^`\n]*`/g, "")
  if (/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i.test(outsideSpans)) return "HTML"
  if (/^\s{0,3}#{1,6}\s/m.test(text)) return "a heading"
  if (/^\s*\|.*\|\s*$/m.test(text)) return "a table"
  return null
}

/** Accept a path the way an agent reads it (`code/src/x.py`) or as the repository names it
 *  (`src/x.py`), and store the latter. */
/** Whether text holds a control character, which no path or page name does. */
const hasControlCharacter = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 0x20)

const repositoryPath = (raw: string): string =>
  raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/^code\//, "")

class Checker {
  readonly errors: string[] = []
  private readonly ids = new Set<string>()

  fail(where: string, problem: string): void {
    this.errors.push(`${where} ${problem}`)
  }

  keys(where: string, v: Json, allowed: readonly string[]): void {
    for (const key of Object.keys(v))
      if (!allowed.includes(key))
        this.fail(`${where}.${key}`, `is not a field of ${PAPER_ANALYSIS_SCHEMA}`)
  }

  object(where: string, v: unknown, allowed: readonly string[]): Json | null {
    if (!isObject(v)) {
      this.fail(where, "must be an object")
      return null
    }
    this.keys(where, v, allowed)
    return v
  }

  array(where: string, v: unknown, max: number, required = false): unknown[] {
    if (v === undefined && !required) return []
    if (!Array.isArray(v)) {
      this.fail(where, "must be an array")
      return []
    }
    if (v.length > max) this.fail(where, `holds ${v.length} entries; at most ${max}`)
    return v.slice(0, max)
  }

  text(
    where: string,
    v: unknown,
    max: number,
    opts: { optional?: boolean; prose?: boolean; line?: boolean } = {},
  ): string | undefined {
    if (v === undefined && opts.optional) return undefined
    if (typeof v !== "string" || !v.trim()) {
      this.fail(where, "must be a non-empty string")
      return undefined
    }
    if (v.length > max) this.fail(where, `is ${v.length} characters; at most ${max}`)
    if (opts.line && /[\r\n]/.test(v)) this.fail(where, "must be one line")
    if (opts.prose) {
      const problem = proseProblem(v)
      if (problem)
        this.fail(
          where,
          `may use inline markdown only, and holds ${problem}: refer to code, never quote it`,
        )
    }
    return v.trim()
  }

  id(where: string, v: unknown): string {
    if (typeof v !== "string" || !ID.test(v)) {
      this.fail(where, "must be an id of lowercase letters, digits, dots, dashes or underscores")
      return String(v)
    }
    if (this.ids.has(v)) this.fail(where, `repeats the id "${v}"`)
    this.ids.add(v)
    return v
  }

  lines(where: string, v: unknown): string | undefined {
    if (v === undefined) return undefined
    const m = typeof v === "string" ? LINES.exec(v.trim()) : null
    const from = m ? Number(m[1]) : 0
    const to = m?.[2] ? Number(m[2]) : from
    if (!m || from < 1 || to < from) {
      this.fail(where, `must be a line or a range like "40" or "40-88"`)
      return undefined
    }
    return from === to ? `${from}` : `${from}-${to}`
  }

  codeRef(where: string, v: unknown): AnalysisCodeRef | null {
    const o = this.object(where, v, ["path", "symbol", "lines"])
    if (!o) return null
    const raw = this.text(`${where}.path`, o.path, MAX.path, { line: true })
    const path = raw === undefined ? "" : repositoryPath(raw)
    if (raw !== undefined) {
      const parts = path.split("/")
      if (
        !path ||
        /[\\`]/.test(path) ||
        hasControlCharacter(path) ||
        parts.some((p) => p === "" || p === "." || p === "..")
      )
        this.fail(`${where}.path`, "must be a file's path inside the repository")
    }
    const symbol = this.text(`${where}.symbol`, o.symbol, MAX.symbol, {
      optional: true,
      line: true,
    })
    if (symbol?.includes("`")) this.fail(`${where}.symbol`, "must not contain a backtick")
    const lines = this.lines(`${where}.lines`, o.lines)
    return { path, ...(symbol ? { symbol } : {}), ...(lines ? { lines } : {}) }
  }

  paperRef(where: string, v: unknown): AnalysisPaperRef | null {
    const o = this.object(where, v, ["section", "label"])
    if (!o) return null
    const section = this.text(`${where}.section`, o.section, MAX.section, { line: true }) ?? ""
    if (
      section &&
      (section.includes("`") || hasControlCharacter(section) || /^\/?code\//.test(section))
    )
      this.fail(
        `${where}.section`,
        "must name a page of the paper, as read takes it (main.tex#method)",
      )
    const label = this.text(`${where}.label`, o.label, MAX.label, { optional: true, line: true })
    if (label && /[\s{}`]/.test(label)) this.fail(`${where}.label`, "must be a \\label key")
    return { section, ...(label ? { label } : {}) }
  }

  paperRefs(where: string, v: unknown): AnalysisPaperRef[] {
    return this.array(where, v, MAX.paperRefs)
      .map((ref, i) => this.paperRef(`${where}[${i}]`, ref))
      .filter((r): r is AnalysisPaperRef => r !== null)
  }
}

/** Parse and validate an analysis. Errors name the JSON path of each problem, so an agent can
 *  fix every one in a single revision. */
export const parsePaperAnalysis = (source: string): PaperAnalysisParse => {
  if (new TextEncoder().encode(source).byteLength > PAPER_ANALYSIS_MAX_BYTES)
    return {
      ok: false,
      errors: [
        `the analysis is over ${PAPER_ANALYSIS_MAX_BYTES / 1024} KB; keep notes to what a reader needs`,
      ],
    }
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, errors: ["the analysis must be valid JSON"] }
  }
  const c = new Checker()
  const top = c.object("analysis", raw, [
    "schema",
    "context",
    "based_on",
    "paper",
    "implementation",
    "summary",
    "contributions",
    "unmapped",
    "open_questions",
    "removed",
  ])
  if (!top) return { ok: false, errors: c.errors }
  if (top.schema !== PAPER_ANALYSIS_SCHEMA)
    c.fail("analysis.schema", `must be "${PAPER_ANALYSIS_SCHEMA}"`)
  const context = c.text("analysis.context", top.context, 64, { line: true }) ?? ""
  if (context && !/^ctx_\S+$/.test(context))
    c.fail("analysis.context", "must be the Context's id (ctx_…)")
  const basedOn = top.based_on ?? null
  if (basedOn !== null && !(Number.isInteger(basedOn) && (basedOn as number) > 0))
    c.fail("analysis.based_on", "must be null when creating, or the version you updated from")

  const paperIn = c.object("analysis.paper", top.paper, ["short_id", "arxiv_version"])
  const paperShortId = paperIn
    ? (c.text("analysis.paper.short_id", paperIn.short_id, 64, { line: true }) ?? "")
    : ""
  const arxivVersion = paperIn?.arxiv_version ?? null
  if (arxivVersion !== null && !(Number.isInteger(arxivVersion) && (arxivVersion as number) > 0))
    c.fail(
      "analysis.paper.arxiv_version",
      "must be the arXiv version the Context imported, or null",
    )

  const implIn = c.object("analysis.implementation", top.implementation, ["repository", "commit"])
  const repository = implIn
    ? (c.text("analysis.implementation.repository", implIn.repository, 200, { line: true }) ?? "")
    : ""
  const commit = implIn?.commit ?? null
  if (commit !== null && !(typeof commit === "string" && COMMIT.test(commit)))
    c.fail("analysis.implementation.commit", "must be the commit the Context fetched, or null")

  const summary = c.text("analysis.summary", top.summary, MAX.summary, { prose: true }) ?? ""

  let detailCount = 0
  const contributions: AnalysisContribution[] = []
  const contributionsIn = c.array(
    "analysis.contributions",
    top.contributions,
    MAX.contributions,
    true,
  )
  if (Array.isArray(top.contributions) && top.contributions.length === 0)
    c.fail("analysis.contributions", "must name at least one contribution")
  for (const [i, entry] of contributionsIn.entries()) {
    const where = `analysis.contributions[${i}]`
    const o = c.object(where, entry, ["id", "title", "claim", "paper", "details"])
    if (!o) continue
    const id = c.id(`${where}.id`, o.id)
    const title = c.text(`${where}.title`, o.title, MAX.title, { line: true }) ?? ""
    const claim = c.text(`${where}.claim`, o.claim, MAX.prose, { prose: true }) ?? ""
    const paper = c.paperRefs(`${where}.paper`, o.paper)
    const detailsIn = c.array(`${where}.details`, o.details, MAX.detailsPerContribution, true)
    const details: AnalysisDetail[] = []
    for (const [j, d] of detailsIn.entries()) {
      const dw = `${where}.details[${j}]`
      const od = c.object(dw, d, ["id", "title", "paper", "code", "status", "notes"])
      if (!od) continue
      detailCount++
      const status = od.status as AnalysisStatus
      if (!ANALYSIS_STATUSES.includes(status))
        c.fail(`${dw}.status`, `must be one of ${ANALYSIS_STATUSES.join(", ")}`)
      const code = c
        .array(`${dw}.code`, od.code, MAX.codeRefs)
        .map((ref, k) => c.codeRef(`${dw}.code[${k}]`, ref))
        .filter((r): r is AnalysisCodeRef => r !== null)
      const notes = c.text(`${dw}.notes`, od.notes, MAX.prose, { optional: true, prose: true })
      if (status === "not_found" && code.length > 0)
        c.fail(`${dw}.code`, "must be empty when the status is not_found")
      if (status !== "not_found" && ANALYSIS_STATUSES.includes(status) && code.length === 0)
        c.fail(`${dw}.code`, "must name the code, unless the status is not_found")
      if ((status === "partial" || status === "differs") && !notes)
        c.fail(
          `${dw}.notes`,
          `must say what the code does differently when the status is ${status}`,
        )
      details.push({
        id: c.id(`${dw}.id`, od.id),
        title: c.text(`${dw}.title`, od.title, MAX.title, { line: true }) ?? "",
        paper: c.paperRefs(`${dw}.paper`, od.paper),
        code,
        status,
        ...(notes ? { notes } : {}),
      })
    }
    contributions.push({ id, title, claim, paper, details })
  }
  if (detailCount > MAX.details)
    c.fail("analysis.contributions", `hold ${detailCount} details; at most ${MAX.details}`)

  const unmapped: AnalysisUnmapped[] = []
  for (const [i, entry] of c.array("analysis.unmapped", top.unmapped, MAX.unmapped).entries()) {
    const where = `analysis.unmapped[${i}]`
    const o = c.object(where, entry, ["id", "path", "symbol", "lines", "notes"])
    if (!o) continue
    const id = c.id(`${where}.id`, o.id)
    const ref = c.codeRef(where, { path: o.path, symbol: o.symbol, lines: o.lines })
    const notes = c.text(`${where}.notes`, o.notes, MAX.prose, { prose: true }) ?? ""
    if (ref) unmapped.push({ id, ...ref, notes })
  }

  const openQuestions: AnalysisQuestion[] = []
  for (const [i, entry] of c
    .array("analysis.open_questions", top.open_questions, MAX.questions)
    .entries()) {
    const where = `analysis.open_questions[${i}]`
    const o = c.object(where, entry, ["id", "question"])
    if (!o) continue
    openQuestions.push({
      id: c.id(`${where}.id`, o.id),
      question: c.text(`${where}.question`, o.question, MAX.question, { prose: true }) ?? "",
    })
  }

  const removed: AnalysisRemoval[] = []
  const live = new Set([
    ...contributions.flatMap((x) => [x.id, ...x.details.map((d) => d.id)]),
    ...unmapped.map((u) => u.id),
    ...openQuestions.map((q) => q.id),
  ])
  for (const [i, entry] of c.array("analysis.removed", top.removed, MAX.removed).entries()) {
    const where = `analysis.removed[${i}]`
    const o = c.object(where, entry, ["id", "reason"])
    if (!o) continue
    const id = typeof o.id === "string" ? o.id : ""
    if (!ID.test(id)) c.fail(`${where}.id`, "must be the id of an entry this version drops")
    else if (live.has(id)) c.fail(`${where}.id`, `names "${id}", which this version still has`)
    removed.push({
      id,
      reason: c.text(`${where}.reason`, o.reason, MAX.reason, { prose: true }) ?? "",
    })
  }

  const files = new Set(
    [...contributions.flatMap((x) => x.details.flatMap((d) => d.code)), ...unmapped].map(
      (r) => r.path,
    ),
  )
  if (files.size > MAX.files)
    c.fail("analysis", `refers to ${files.size} files; at most ${MAX.files}`)

  if (c.errors.length > 0) {
    const shown = c.errors.slice(0, MAX.errors)
    const more = c.errors.length - shown.length
    return { ok: false, errors: more > 0 ? [...shown, `and ${more} more`] : shown }
  }
  return {
    ok: true,
    analysis: {
      schema: PAPER_ANALYSIS_SCHEMA,
      context,
      based_on: basedOn as number | null,
      paper: { short_id: paperShortId, arxiv_version: arxivVersion as number | null },
      implementation: { repository, commit: commit as string | null },
      summary,
      contributions,
      unmapped,
      open_questions: openQuestions,
      removed,
    },
  }
}

/** The analysis as it is stored: its own fields in their own order, indented, so an agent can
 *  read a part of it by line. */
export const serializePaperAnalysis = (a: PaperAnalysis): string =>
  `${JSON.stringify(a, null, 2)}\n`

/** Every id the analysis defines. */
export const analysisIds = (a: PaperAnalysis): string[] => [
  ...a.contributions.flatMap((x) => [x.id, ...x.details.map((d) => d.id)]),
  ...a.unmapped.map((u) => u.id),
  ...a.open_questions.map((q) => q.id),
]

/** The ids an update leaves out without saying why: there before, gone now, not in `removed`.
 *  An analysis is corrected in the open, so an entry never quietly disappears. */
export const droppedIds = (previous: PaperAnalysis, next: PaperAnalysis): string[] => {
  const kept = new Set([...analysisIds(next), ...next.removed.map((r) => r.id)])
  return analysisIds(previous).filter((id) => !kept.has(id))
}

export interface AnalysisCounts {
  contributions: number
  details: number
  implemented: number
  partial: number
  differs: number
  not_found: number
  unmapped: number
  open_questions: number
}

export const analysisCounts = (a: PaperAnalysis): AnalysisCounts => {
  const details = a.contributions.flatMap((x) => x.details)
  const count = (s: AnalysisStatus) => details.filter((d) => d.status === s).length
  return {
    contributions: a.contributions.length,
    details: details.length,
    implemented: count("implemented"),
    partial: count("partial"),
    differs: count("differs"),
    not_found: count("not_found"),
    unmapped: a.unmapped.length,
    open_questions: a.open_questions.length,
  }
}

/** Why the analysis no longer describes what the Context holds: each thing it was made against
 *  that has since changed. Empty when it is current. */
export const analysisStaleness = (
  a: PaperAnalysis,
  now: { arxivVersion: number | null; repository: string | null; commit: string | null },
): string[] => {
  const reasons: string[] = []
  if (a.paper.arxiv_version !== now.arxivVersion)
    reasons.push(
      `it was made against arXiv version ${a.paper.arxiv_version ?? "unknown"}, and the paper is now version ${now.arxivVersion ?? "unknown"}`,
    )
  if (now.repository === null) reasons.push("the implementation has been removed from the paper")
  else if (a.implementation.repository !== now.repository)
    reasons.push(
      `it was made against ${a.implementation.repository}, and the implementation is now ${now.repository}`,
    )
  else if (a.implementation.commit !== now.commit)
    reasons.push(
      `it was made against commit ${a.implementation.commit?.slice(0, 7) ?? "unknown"}, and the implementation is now at ${now.commit?.slice(0, 7) ?? "an unrecorded commit"}`,
    )
  return reasons
}

/** Every code reference, with where it sits in the analysis. */
export const analysisCodeRefs = (a: PaperAnalysis): { where: string; ref: AnalysisCodeRef }[] => [
  ...a.contributions.flatMap((x, i) =>
    x.details.flatMap((d, j) =>
      d.code.map((ref, k) => ({
        where: `analysis.contributions[${i}].details[${j}].code[${k}]`,
        ref,
      })),
    ),
  ),
  ...a.unmapped.map((u, i) => ({ where: `analysis.unmapped[${i}]`, ref: u as AnalysisCodeRef })),
]

/** Every paper reference, with where it sits in the analysis. */
export const analysisPaperRefs = (a: PaperAnalysis): { where: string; ref: AnalysisPaperRef }[] =>
  a.contributions.flatMap((x, i) => [
    ...x.paper.map((ref, k) => ({ where: `analysis.contributions[${i}].paper[${k}]`, ref })),
    ...x.details.flatMap((d, j) =>
      d.paper.map((ref, k) => ({
        where: `analysis.contributions[${i}].details[${j}].paper[${k}]`,
        ref,
      })),
    ),
  ])

export const ANALYSIS_STATUS_LABEL: Record<AnalysisStatus, string> = {
  implemented: "Implemented",
  partial: "Partly implemented",
  differs: "Differs from the paper",
  not_found: "Not found in the code",
}

export interface AnalysisLinks {
  /** Where a code reference opens for a person, and whether that is the exact commit read. */
  code: (ref: AnalysisCodeRef) => { href: string; pinned: boolean } | null
  /** Where a paper reference opens for a person. */
  paper: (ref: AnalysisPaperRef) => string | null
}

const codeText = (ref: AnalysisCodeRef): string =>
  [
    `\`${ref.path}\``,
    ref.symbol ? `\`${ref.symbol}\`` : null,
    ref.lines ? `lines ${ref.lines}` : null,
  ]
    .filter(Boolean)
    .join(" ")

const codeLink = (ref: AnalysisCodeRef, links: AnalysisLinks): string => {
  const target = links.code(ref)
  if (!target) return codeText(ref)
  return `[${codeText(ref)}](${target.href})${target.pinned ? "" : " (not pinned to a commit)"}`
}

const paperLink = (ref: AnalysisPaperRef, links: AnalysisLinks): string => {
  const text = `${ref.section}${ref.label ? ` (${ref.label})` : ""}`
  const href = links.paper(ref)
  return href ? `[${text}](${href})` : text
}

/**
 * The analysis as a page a person reads: a summary, then every contribution with its details,
 * each detail's status, the paper it cites and links to the code. It is generated, never
 * written by hand, so it cannot drift from the data it shows.
 */
export const renderPaperAnalysisMarkdown = (
  a: PaperAnalysis,
  opts: { paperTitle: string | null; links: AnalysisLinks },
): string => {
  const counts = analysisCounts(a)
  const out: string[] = [
    `# Implementation analysis${opts.paperTitle ? `: ${opts.paperTitle}` : ""}`,
    "",
    a.summary,
    "",
    `Made against arXiv version ${a.paper.arxiv_version ?? "unknown"} of the paper and ${a.implementation.repository}${a.implementation.commit ? ` at \`${a.implementation.commit.slice(0, 7)}\`` : ""}.`,
    "",
    `${counts.contributions} ${counts.contributions === 1 ? "contribution" : "contributions"}, ${counts.details} ${counts.details === 1 ? "detail" : "details"}: ${ANALYSIS_STATUSES.map((s) => `${counts[s]} ${ANALYSIS_STATUS_LABEL[s].toLowerCase()}`).join(", ")}.`,
  ]
  for (const [i, x] of a.contributions.entries()) {
    out.push("", `## ${i + 1}. ${x.title}`, "", x.claim)
    if (x.paper.length)
      out.push("", `Paper: ${x.paper.map((r) => paperLink(r, opts.links)).join(", ")}`)
    for (const d of x.details) {
      out.push("", `### ${d.title}`, "", `**${ANALYSIS_STATUS_LABEL[d.status]}**`)
      const refs = [
        ...(d.paper.length
          ? [`- Paper: ${d.paper.map((r) => paperLink(r, opts.links)).join(", ")}`]
          : []),
        ...d.code.map((ref) => `- Code: ${codeLink(ref, opts.links)}`),
      ]
      if (refs.length) out.push("", ...refs)
      if (d.notes) out.push("", d.notes)
    }
  }
  if (a.unmapped.length) {
    out.push("", "## Code the paper does not describe", "")
    for (const u of a.unmapped) out.push(`- ${codeLink(u, opts.links)}: ${u.notes}`)
  }
  if (a.open_questions.length) {
    out.push("", "## Open questions", "")
    for (const q of a.open_questions) out.push(`- ${q.question}`)
  }
  if (a.removed.length) {
    out.push("", "## Removed in this version", "")
    for (const r of a.removed) out.push(`- \`${r.id}\`: ${r.reason}`)
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`
}
