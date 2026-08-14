import type { TemplateLibraryRecord } from "@derive/core"

export type TemplateLibraryCursor = { createdAt: string; id: string }

export const parseTemplateLibraryCursor = (
  cursor?: string,
): TemplateLibraryCursor | undefined | null => {
  if (!cursor) return undefined
  const split = cursor.lastIndexOf("~")
  if (split < 1) return null
  const createdAt = cursor.slice(0, split)
  const id = cursor.slice(split + 1)
  if (!id || Number.isNaN(Date.parse(createdAt))) return null
  return { createdAt, id }
}

export const templateLibraryCursor = (library: TemplateLibraryRecord): string =>
  `${library.created_at}~${library.id}`
