// The one artifact an imported Context is: the paper.
//
// An import used to publish two artifacts, a generated Markdown manifest and the paper
// bundle it pointed at. The manifest duplicated what the paper already says: a LaTeX
// paper carries its own title, authors and abstract, and the rendered page shows them.
// So the Context's artifact IS the paper, from the first second: this module writes the
// placeholder paper the queue publishes (so the entry exists and reads honestly while the
// fetch is on its way), the one it leaves behind when an import gives up, and the small
// summary a `read` of the Context inlines, computed from the paper rather than stored
// beside it.
import { latexToText, parseBibtex } from "@derive/core"
import { truncate } from "./text"

/** What arXiv's Atom feed says about a paper. */
export interface ArxivPaperMeta {
  title: string
  authors: string[]
  abstract: string
  published: string | null
  primaryCategory: string | null
  categories: string[]
  doi: string | null
  journalRef: string | null
  /** The version arXiv resolved the reference to (`2`), when the Atom id carried one. */
  version: number | null
  /** The comment field, where a withdrawal is announced. */
  comment: string | null
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim()

/** LaTeX-free, single-line text for a title or a name. */
export const plainText = (s: string, max: number): string => truncate(oneLine(latexToText(s)), max)

/** Escape the few characters that would end the placeholder's own LaTeX. */
const tex = (s: string): string => oneLine(s).replace(/[\\{}$&#^_~%]/g, "")

const placeholder = (title: string, body: string[]): string =>
  [
    "\\documentclass{article}",
    `\\title{${tex(title)}}`,
    "\\author{arXiv}",
    "\\begin{document}",
    "\\maketitle",
    ...body.map((line) => `${tex(line)}\n`),
    "\\end{document}",
    "",
  ].join("\n")

/** The paper before it arrives: a real document, so the artifact renders and reads as
 *  "on its way" rather than as an empty page. Replaced by the paper itself. */
export const fetchingPaper = (ref: string): string =>
  placeholder(`arXiv:${ref}`, [
    "Fetching this paper from arXiv. Its text, figures and bibliography usually arrive within a minute, and this page becomes the paper.",
    `Abstract page: https://arxiv.org/abs/${ref}`,
  ])

/** What an import that gave up leaves behind, so the page never says "fetching" forever. */
export const failedPaper = (ref: string, reason: string): string =>
  placeholder(`arXiv:${ref}`, [
    `Import failed: ${reason}`,
    "Nothing was fetched. The Context's owner can try the import again from its console, or discard it.",
    `Abstract page: https://arxiv.org/abs/${ref}`,
  ])

/** The paper's own abstract, from its source. Papers write it as an environment; a few
 *  use `\abstract{...}`. Null when neither is there. */
export const abstractOf = (source: string): string | null => {
  const env = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/i.exec(source)
  const macro = env ? null : /\\abstract\s*\{([\s\S]{0,4000}?)\}\s*(?:\n|\\)/i.exec(source)
  const raw = env?.[1] ?? macro?.[1]
  if (!raw) return null
  const text = oneLine(latexToText(raw))
  return text || null
}

/** `<Authors> · <Year> · arXiv:<id>`: the line a Contexts row shows under the name. */
export const bylineOf = (ref: string, authors: string[], year: string | null): string => {
  const names = authors.map((a) => plainText(a, 80)).filter(Boolean)
  const who =
    names.length === 0
      ? "Unknown authors"
      : names.length <= 3
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
  return [who, year, `arXiv:${ref}`].filter(Boolean).join(" · ")
}

export interface PaperSummaryInput {
  /** The bare arXiv id. */
  ref: string
  title: string
  /** The author line the paper was published with. */
  authors: string | null
  version: number | null
  abstract: string | null
  /** The paper's own BibTeX entry (its bundle's CITATION.bib). */
  bibtex: string | null
}

/**
 * What a `read` of an imported Context inlines: who wrote the paper, what it is about,
 * and how to cite it. Computed from the paper on every read, never stored: the paper is
 * the only artifact, and a copy beside it could only go stale.
 */
export const paperSummary = (x: PaperSummaryInput): string => {
  const lines = [
    `# ${plainText(x.title, 200) || `arXiv:${x.ref}`}`,
    "",
    [x.authors, `arXiv:${x.ref}${x.version ? `v${x.version}` : ""}`].filter(Boolean).join(" · "),
    "",
    `Abstract page: https://arxiv.org/abs/${x.ref}`,
    "",
  ]
  if (x.abstract) lines.push("## Abstract", "", truncate(x.abstract, 4000), "")
  lines.push(
    "## Reading and citing",
    "",
    "This Context is the paper itself: read it by its short id for the full source, section by section. It is locked, so it stays the version arXiv published. Cite it with the entry below.",
    "",
  )
  if (x.bibtex) lines.push("```bibtex", x.bibtex.trim(), "```", "")
  return lines.join("\n")
}

/** The key an agent cites the paper by, from its CITATION.bib. */
export const citationKeyOf = (bibtex: string | null): string | null =>
  bibtex ? (parseBibtex(bibtex).entries[0]?.key ?? null) : null
