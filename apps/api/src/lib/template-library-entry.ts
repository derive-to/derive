import type { TemplateLibraryEntryRecord } from "@derive/core"

export type TemplateInputMetadata = {
  name: string
  description: string
  required?: boolean
}

const array = <T>(raw: string, is: (value: unknown) => value is T): T[] => {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter(is) : []
  } catch {
    return []
  }
}

const stringValue = (value: unknown): value is string => typeof value === "string"
const inputValue = (value: unknown): value is TemplateInputMetadata =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { name?: unknown }).name === "string" &&
  typeof (value as { description?: unknown }).description === "string" &&
  ((value as { required?: unknown }).required === undefined ||
    typeof (value as { required?: unknown }).required === "boolean")

/** One defensive public projection for HTTP and MCP. Corrupt legacy JSON can
 * lose an invalid member, but it can never leak arbitrary stored objects or
 * make one whole library unreadable. */
export const templateLibraryEntryJson = (entry: TemplateLibraryEntryRecord) => ({
  id: entry.id,
  library_id: entry.library_id,
  source_version: entry.source_version,
  kind: entry.kind,
  category: entry.category,
  format: entry.format,
  title: entry.title,
  description: entry.description,
  outcome: entry.outcome,
  sections: array(entry.sections_json, stringValue),
  inputs: array(entry.inputs_json, inputValue),
  tags: array(entry.tags_json, stringValue),
  created_at: entry.created_at,
})
