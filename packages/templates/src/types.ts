export const TEMPLATE_CATALOG_VERSION = 1
export const BUILT_INS_LIBRARY_ID = "derive/built-ins"

export type TemplateKind = "artifact" | "context"
export type TemplateCategory = "Deck" | "Doc" | "Report" | "Site" | "Agent"
export type TemplateFormat = "md" | "html"

export type TemplateInput = {
  name: string
  description: string
  required?: boolean
}

export type TemplateDefinition = {
  id: string
  kind: TemplateKind
  category: TemplateCategory
  format: TemplateFormat
  title: string
  defaultTitle: string
  description: string
  outcome: string
  sections: readonly string[]
  inputs: readonly TemplateInput[]
  tags: readonly string[]
  featured?: boolean
  starterPrompts?: readonly string[]
}

export type BuiltInTemplate = TemplateDefinition & {
  libraryId: typeof BUILT_INS_LIBRARY_ID
  catalogVersion: typeof TEMPLATE_CATALOG_VERSION
}

export type TemplateDraft = {
  source: string
  filename: string
  mimeType: "text/markdown" | "text/html"
  title: string
  message: string
  template: BuiltInTemplate
}

export type TemplateResource = {
  uri: string
  title: string
  description: string
  mimeType: "application/json"
  text: string
}
