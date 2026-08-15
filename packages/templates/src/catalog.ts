import { AGENT_ARTIFACT_TEMPLATE_DEFINITIONS } from "./built-ins/agent-artifacts"
import { CONTEXT_TEMPLATE_DEFINITIONS } from "./built-ins/contexts"
import { DECK_TEMPLATE_DEFINITIONS } from "./built-ins/decks"
import { DOC_TEMPLATE_DEFINITIONS } from "./built-ins/docs"
import { REPORT_TEMPLATE_DEFINITIONS } from "./built-ins/reports"
import { SITE_TEMPLATE_DEFINITIONS } from "./built-ins/sites"
import {
  BUILT_INS_LIBRARY_ID,
  type BuiltInTemplate,
  TEMPLATE_CATALOG_VERSION,
  type TemplateCategory,
  type TemplateDefinition,
  type TemplateKind,
} from "./types"

const ARTIFACT_TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  ...DECK_TEMPLATE_DEFINITIONS,
  ...DOC_TEMPLATE_DEFINITIONS,
  ...REPORT_TEMPLATE_DEFINITIONS,
  ...SITE_TEMPLATE_DEFINITIONS,
  ...AGENT_ARTIFACT_TEMPLATE_DEFINITIONS,
]

const builtIn = (template: TemplateDefinition): BuiltInTemplate => ({
  ...template,
  libraryId: BUILT_INS_LIBRARY_ID,
  catalogVersion: TEMPLATE_CATALOG_VERSION,
})

const ARTIFACT_TEMPLATES = ARTIFACT_TEMPLATE_DEFINITIONS.map(builtIn)
const CONTEXT_TEMPLATES = CONTEXT_TEMPLATE_DEFINITIONS.map(builtIn)
export const BUILT_IN_TEMPLATES = [...ARTIFACT_TEMPLATES, ...CONTEXT_TEMPLATES]

export function listTemplates(filter?: {
  kind?: TemplateKind
  category?: TemplateCategory
  query?: string
}): readonly BuiltInTemplate[] {
  const needle = filter?.query?.trim().toLowerCase() ?? ""
  return BUILT_IN_TEMPLATES.filter((template) => {
    if (filter?.kind && template.kind !== filter.kind) return false
    if (filter?.category && template.category !== filter.category) return false
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
  })
}

export function getTemplate(id: string | undefined): BuiltInTemplate | undefined {
  if (!id) return undefined
  return BUILT_IN_TEMPLATES.find((template) => template.id === id)
}
