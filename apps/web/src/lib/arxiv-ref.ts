// The client's copy of the arXiv reference grammar (packages/core/src/arxiv.ts): the web
// never imports core at runtime, and the form wants to say "arXiv:2401.12345v2" or "Not an
// arXiv link" as the person types, before the server is asked. The server's parser is the
// one that decides; this only previews. Kept to the same table of cases as core's test.

export interface ArxivRefPreview {
  id: string
  version: number | null
  canonical: string
}

const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v([1-9]\d*))?$/i

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

const parseId = (raw: string): ArxivRefPreview | null => {
  const m = ARXIV_ID.exec(raw)
  if (!m) return null
  let id = m[1] ?? ""
  const slash = id.indexOf("/")
  if (slash !== -1) {
    const [archive = "", cls] = id.slice(0, slash).split(".")
    id = `${archive.toLowerCase()}${cls ? `.${cls}` : ""}${id.slice(slash)}`
  }
  const version = m[2] ? Number(m[2]) : null
  return { id, version, canonical: version === null ? id : `${id}v${version}` }
}

export const previewArxivRef = (input: string): ArxivRefPreview | null => {
  let s = input.trim()
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim()
  s = s.replace(/[.,;:)\]]+$/, "")
  if (!s || /[^\x20-\x7e]/.test(s)) return null
  const prefixed = /^arxiv:\s*(.+)$/i.exec(s)
  if (prefixed) return parseId(prefixed[1] ?? "")
  const doi = /^(?:doi:\s*)?10\.48550\/arXiv\.(.+)$/i.exec(s)
  if (doi) return parseId(doi[1] ?? "")
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

export const arxivAbsUrl = (canonical: string): string => `https://arxiv.org/abs/${canonical}`
