export const TEMPLATE_CATALOG_VERSION = 1
export const BUILT_INS_LIBRARY_ID = "derive/built-ins"

export type TemplateKind = "artifact" | "context"
export type TemplateCategory = "Deck" | "Doc" | "Report" | "Site" | "Agent"
export type TemplateFormat = "md" | "html"
// This is metadata on an authored Template, not the Theme catalog. It lets the
// existing web prototype describe a template honestly while Themes stays a
// separate, additive follow-up.
export type ThemeMode = "native" | "adaptable" | "fixed"

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
  themeMode: ThemeMode
  featured?: boolean
  starterPrompts?: readonly string[]
}

export type TemplateRef = {
  libraryId: typeof BUILT_INS_LIBRARY_ID
  templateId: string
  catalogVersion: typeof TEMPLATE_CATALOG_VERSION
}

export type BuiltInTemplate = TemplateDefinition & {
  libraryId: typeof BUILT_INS_LIBRARY_ID
  catalogVersion: typeof TEMPLATE_CATALOG_VERSION
}

// A rendering adapter, not a Theme object. The Templates package needs no Theme
// catalog to produce a deterministic starter; the web prototype may pass a visual
// recipe until Themes becomes its own package surface.
export type TemplateVisualTheme = {
  id: string
  css: string
}

export type TemplateDraft = {
  source: string
  filename: string
  mimeType: "text/markdown" | "text/html"
  title: string
  message: string
  format: TemplateFormat
  template: BuiltInTemplate
  origin: TemplateRef
}

export type TemplateResource = {
  uri: string
  title: string
  description: string
  mimeType: "application/json"
  text: string
}
