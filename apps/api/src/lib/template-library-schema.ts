/**
 * PR previews intentionally share production data but do not run unmerged DDL.
 * Recognize only the narrow, known missing-table failure so a template-library
 * release can explain that sequencing state without masking real database
 * outages as an empty catalog.
 */
export const isTemplateLibrarySchemaUnavailable = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error

  for (let depth = 0; current != null && depth < 6 && !seen.has(current); depth++) {
    seen.add(current)
    if (typeof current === "string") {
      if (/no such table:\s*(?:main\.)?template_library(?:_entry)?\b/i.test(current)) return true
      if (/relation\s+["']?template_library(?:_entry)?["']?\s+does not exist/i.test(current))
        return true
      break
    }
    if (typeof current !== "object") break

    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (candidate.code === "42P01") return true
    if (typeof candidate.message === "string") {
      if (/no such table:\s*(?:main\.)?template_library(?:_entry)?\b/i.test(candidate.message))
        return true
      if (
        /relation\s+["']?template_library(?:_entry)?["']?\s+does not exist/i.test(candidate.message)
      )
        return true
    }
    current = candidate.cause
  }

  return false
}
