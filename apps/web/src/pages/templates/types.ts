import type { TemplateCategory } from "@derive-to/templates"

export type {
  BuiltInTemplate,
  TemplateCategory,
  TemplateFormat,
  TemplateInput,
} from "@derive-to/templates"

export type TemplateTab = "artifacts" | "contexts" | "libraries"

export type TemplatesSearch = {
  tab?: TemplateTab
  query?: string
  category?: TemplateCategory
  selected?: string
  derive?: boolean
  source?: string
  library?: string
  use?: string
}

export type NewArtifactSearch = {
  start?: "deck"
  template?: string
  source?: string
  library?: string
  entry?: string
  next?: "context"
  contextName?: string
}

export type ContextsSearch = {
  manifest?: string
  name?: string
  origin?: string
}
