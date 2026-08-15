const AUTHORED_TEMPLATE_ROOT = "derive://template-libraries"
const TEMPLATE_ID = /^[A-Za-z0-9_-]+$/

export type AuthoredTemplateUri = {
  libraryId: string
  entryId?: string
}

/** Format one canonical authored-library URI. IDs are validated so callers
 * cannot manufacture an address the strict parser would later interpret
 * differently. */
export const templateLibraryUri = (libraryId: string, entryId?: string): string => {
  if (!TEMPLATE_ID.test(libraryId) || (entryId !== undefined && !TEMPLATE_ID.test(entryId)))
    throw new Error(
      "template library URI ids may contain letters, numbers, underscores, and dashes",
    )
  return entryId
    ? `${AUTHORED_TEMPLATE_ROOT}/${libraryId}/${entryId}`
    : `${AUTHORED_TEMPLATE_ROOT}/${libraryId}`
}

/** Parse only complete canonical URIs. Extra segments, empty IDs, query
 * strings, and fragments fail closed instead of being silently ignored. */
export const parseTemplateLibraryUri = (uri: string): AuthoredTemplateUri | null => {
  const match = uri.match(
    /^derive:\/\/template-libraries\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/,
  )
  if (!match?.[1]) return null
  return { libraryId: match[1], ...(match[2] ? { entryId: match[2] } : {}) }
}

export const TEMPLATE_LIBRARY_CATALOG_URI = AUTHORED_TEMPLATE_ROOT
