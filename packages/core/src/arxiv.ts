/**
 * arXiv references, the way people paste them.
 *
 * An import starts from whatever the person has in their clipboard: the abstract page, a
 * PDF link, a versioned HTML page, a DOI, a bare id, an `arXiv:` prefix from a citation.
 * Every one of those is untrusted text, and the id it carries is what the importer will
 * put into URLs it fetches from and into the manifest it writes, so the grammar here is
 * strict rather than forgiving: an exact host allowlist with a path shape per host, the
 * two published id forms and nothing else, ASCII only. Anything that does not match is
 * "not an arXiv link", never a best guess.
 *
 * `arxivUrls` is the only place a request URL is built from an id, so the importer can
 * never be steered to another host by the pasted text.
 */

import { cleanPastedReference } from "./pasted-reference"

export interface ArxivRef {
  /** The bare id (`2401.12345`, `hep-th/9901001`), version stripped. */
  id: string
  /** The requested version, when the reference pinned one. */
  version: number | null
  /** The id with its version suffix when one was given (`2401.12345v2`). */
  canonical: string
}

/** New-style `YYMM.NNNNN` (four or five digits) or old-style `archive[.class]/YYMMNNN`,
 *  each with an optional `vN`. The subject class keeps its case (`math.GT`); the archive
 *  and the `v` are lowercased on output. */
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v([1-9]\d*))?$/i

/** Path shapes per host. Each captures the id (with its optional version) in group 1. */
const HOST_PATHS: Record<string, RegExp> = {
  "arxiv.org": /^\/(?:abs|pdf|html|src|e-print|format|ps)\/(.+?)(?:\.pdf)?$/i,
  "www.arxiv.org": /^\/(?:abs|pdf|html|src|e-print|format|ps)\/(.+?)(?:\.pdf)?$/i,
  "export.arxiv.org": /^\/(?:abs|pdf|html|src|e-print|format|ps)\/(.+?)(?:\.pdf)?$/i,
  "browse.arxiv.org": /^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?$/i,
  "ar5iv.org": /^\/(?:abs|html)\/(.+?)$/i,
  "ar5iv.labs.arxiv.org": /^\/(?:abs|html)\/(.+?)$/i,
  "alphaxiv.org": /^\/(?:abs|overview)\/(.+?)$/i,
  "www.alphaxiv.org": /^\/(?:abs|overview)\/(.+?)$/i,
  "doi.org": /^\/10\.48550\/arXiv\.(.+?)$/i,
  "huggingface.co": /^\/papers\/(.+?)$/i,
}

const parseId = (raw: string): ArxivRef | null => {
  const m = ARXIV_ID.exec(raw)
  if (!m) return null
  let id = m[1] ?? ""
  const slash = id.indexOf("/")
  if (slash !== -1) {
    // Old-style ids lowercase the archive and keep the class (`math.GT/0309136`).
    const [archive = "", cls] = id.slice(0, slash).split(".")
    id = `${archive.toLowerCase()}${cls ? `.${cls}` : ""}${id.slice(slash)}`
  }
  const version = m[2] ? Number(m[2]) : null
  return { id, version, canonical: version === null ? id : `${id}v${version}` }
}

/**
 * Parse a pasted arXiv reference. Null means "not an arXiv link"; the caller shows that
 * verbatim rather than guessing. Accepts a link on one of the known hosts, `arXiv:<id>`,
 * the arXiv DOI (`10.48550/arXiv.<id>`), or a bare id, with trailing sentence
 * punctuation and surrounding angle brackets tolerated because that is how ids arrive
 * from a bibliography or an email.
 */
export const parseArxivRef = (input: string): ArxivRef | null => {
  const s = cleanPastedReference(input)
  if (!s || /[^\x20-\x7e]/.test(s)) return null

  const prefixed = /^arxiv:\s*(.+)$/i.exec(s)
  if (prefixed) return parseId(prefixed[1] ?? "")
  const doi = /^(?:doi:\s*)?10\.48550\/arXiv\.(.+)$/i.exec(s)
  if (doi) return parseId(doi[1] ?? "")

  // A link: with a scheme, or a bare host from the allowlist followed by a path.
  const bareHost = /^([a-z0-9.-]+)\//i.exec(s)
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    ? s
    : bareHost && Object.hasOwn(HOST_PATHS, bareHost[1]?.toLowerCase() ?? "")
      ? `https://${s}`
      : null
  if (candidate) {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      return null
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    const shape = HOST_PATHS[url.hostname.toLowerCase()]
    if (!shape) return null
    const m = shape.exec(url.pathname)
    if (!m) return null
    try {
      return parseId(decodeURIComponent(m[1] ?? ""))
    } catch {
      return null
    }
  }

  return parseId(s)
}

/** The three arXiv endpoints an import reads, built only from a parsed reference. */
export const arxivUrls = (
  ref: Pick<ArxivRef, "id" | "canonical">,
): { source: string; metadata: string; bibtex: string } => ({
  source: `https://arxiv.org/src/${ref.canonical}`,
  metadata: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ref.canonical)}`,
  bibtex: `https://arxiv.org/bibtex/${ref.id}`,
})

/** The abstract page, for links shown to people. */
export const arxivAbsUrl = (ref: Pick<ArxivRef, "canonical"> | string): string =>
  `https://arxiv.org/abs/${typeof ref === "string" ? ref : ref.canonical}`
