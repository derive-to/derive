import type { BuiltInTemplate } from "./types"

export function getTemplate(
  templates: readonly BuiltInTemplate[],
  id: string | undefined,
): BuiltInTemplate | undefined {
  if (!id) return undefined
  return templates.find((template) => template.id === id)
}

export function templateMatches(template: BuiltInTemplate, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [
    template.title,
    template.description,
    template.outcome,
    template.category,
    ...template.tags,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle)
}
