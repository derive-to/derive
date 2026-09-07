// What each import failure means for a reader, keyed by the server's error code (see
// apps/api/src/lib/arxiv-import.ts). The console panel, the list badge and the form share
// this one table so one failure never gets two explanations.
export const IMPORT_ERROR_COPY: Record<string, string> = {
  not_arxiv:
    "That doesn't look like an arXiv link. Paste the abstract page (arxiv.org/abs/…) or an id like 2401.12345.",
  not_a_repo:
    "That doesn't look like a public GitHub or GitLab repository. Paste the repository's page, like github.com/owner/project.",
  not_found: "arXiv has no paper with this id.",
  withdrawn: "This paper was withdrawn from arXiv.",
  no_source: "arXiv has only a PDF for this paper, no LaTeX source, so Derive can't read it.",
  no_tex: "The source has no main .tex file Derive can read.",
  too_large: "The source is larger than Derive imports, even after shrinking its figures.",
  rate_limited: "arXiv asked Derive to slow down. It will try again in a few minutes.",
  unavailable: "arXiv didn't answer. Derive will try again shortly.",
}

/** Codes a person can do something about by trying again. */
export const RETRYABLE_IMPORT_CODES = new Set(["rate_limited", "unavailable"])

export const importErrorCopy = (code: string | null, fallback: string): string =>
  (code && IMPORT_ERROR_COPY[code]) || fallback
