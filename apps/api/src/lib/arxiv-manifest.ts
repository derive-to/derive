// The manifest an imported paper's Context carries. Written twice: a stub the moment the
// import is queued (so the Context lists and reads as "fetching" from the first second),
// and the real one once the paper is published. Frontmatter holds machine values only
// (the reference, the version, the `documents:` pointer); everything arXiv said about the
// paper (title, authors, abstract, BibTeX) goes in the body as prose, after latexToText
// and a whitespace collapse, so a title with a stray quote or newline can never break the
// frontmatter the runner and the server both parse.
import { arxivAbsUrl, latexToText } from "@derive/core"
import { truncate } from "./text"

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

/** A YAML double-quoted scalar that stays on one line whatever the value held. */
const quoted = (s: string): string => {
  let out = ""
  for (const ch of oneLine(s)) {
    if (ch === "\\" || ch.charCodeAt(0) < 0x20) continue
    out += ch === '"' ? "'" : ch
  }
  return `"${out}"`
}

/** `<Authors> · <Year> · arXiv:<id> (<category>)`: the manifest's first paragraph, which
 *  is what the Contexts list shows under the name. */
export const bylineOf = (ref: string, meta: ArxivPaperMeta): string => {
  const names = meta.authors.map((a) => plainText(a, 80)).filter(Boolean)
  const authors =
    names.length === 0
      ? "Unknown authors"
      : names.length <= 3
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
  const year = meta.published?.slice(0, 4)
  const category = meta.primaryCategory ? ` (${meta.primaryCategory})` : ""
  return `${authors}${year ? ` · ${year}` : ""} · arXiv:${ref}${category}`
}

export const stubManifest = (ref: string): string =>
  [
    "---",
    `name: ${quoted(`arXiv:${ref}`)}`,
    "source: arxiv",
    `arxiv: ${ref}`,
    "---",
    `# arXiv:${ref}`,
    "",
    "Fetching this paper from arXiv. The title, abstract and source usually arrive within a minute.",
    "",
    `Abstract page: ${arxivAbsUrl(ref)}`,
    "",
  ].join("\n")

export interface ReadyManifestInput {
  ref: string
  meta: ArxivPaperMeta
  /** The published paper bundle's short id, bound as the Context's document. */
  paperShortId: string
  bibtex: string | null
  notes: string[]
}

export const readyManifest = (x: ReadyManifestInput): string => {
  const title = plainText(x.meta.title, 200) || `arXiv:${x.ref}`
  const lines = [
    "---",
    `name: ${quoted(truncate(title, 80))}`,
    "source: arxiv",
    `arxiv: ${x.ref}`,
    ...(x.meta.version ? [`arxiv_version: ${x.meta.version}`] : []),
    "documents:",
    `  - id: ${x.paperShortId}`,
    "    role: paper",
    "---",
    `# ${title}`,
    "",
    bylineOf(x.ref, x.meta),
    "",
    `Abstract page: ${arxivAbsUrl(x.ref)}`,
    ...(x.meta.doi ? [`DOI: https://doi.org/${x.meta.doi}`] : []),
    ...(x.meta.journalRef ? [`Published as: ${plainText(x.meta.journalRef, 300)}`] : []),
    "",
    "## Abstract",
    "",
    oneLine(latexToText(x.meta.abstract)) || "(arXiv lists no abstract for this paper.)",
    "",
    "## Reading and citing",
    "",
    "The paper is the `documents` pointer above: its LaTeX source, figures and bibliography, published as one bundle. Read it by short id for the full text. It is locked, not immutable: comments are the place for suggestions, and an editor can unlock it deliberately. Cite it with the entry below.",
    "",
  ]
  if (x.bibtex) lines.push("```bibtex", x.bibtex.trim(), "```", "")
  if (x.notes.length) {
    lines.push("## Import notes", "")
    for (const n of x.notes) lines.push(`- ${oneLine(n)}`)
    lines.push("")
  }
  return lines.join("\n")
}

/** The manifest of an import that gave up, so a read never says "fetching" forever. */
export const failedManifest = (ref: string, reason: string): string =>
  [
    "---",
    `name: ${quoted(`arXiv:${ref}`)}`,
    "source: arxiv",
    `arxiv: ${ref}`,
    "---",
    `# arXiv:${ref}`,
    "",
    `Import failed: ${oneLine(reason)}`,
    "",
    "Nothing was fetched. The Context's owner can try the import again from its console, or discard it.",
    "",
    `Abstract page: ${arxivAbsUrl(ref)}`,
    "",
  ].join("\n")
