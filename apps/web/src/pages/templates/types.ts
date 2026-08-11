import type { TemplateCategory } from "@derive-to/templates"

export type {
  BuiltInTemplate,
  TemplateCategory,
  TemplateFormat,
  TemplateInput,
  ThemeMode,
} from "@derive-to/templates"

export type TemplateTab = "artifacts" | "contexts" | "themes"

export type ThemeMotif = "editorial" | "operator" | "field" | "institutional" | "signal"

export type BuiltInTheme = {
  id: string
  title: string
  description: string
  tone: string
  motif: ThemeMotif
  bestFor: string[]
}

export type TemplatesSearch = {
  tab?: TemplateTab
  query?: string
  category?: TemplateCategory
  selected?: string
  theme?: string
  derive?: boolean
}

export type NewArtifactSearch = {
  template?: string
  theme?: string
  source?: string
  next?: "context"
  contextName?: string
}

export type ContextsSearch = {
  manifest?: string
  name?: string
  origin?: string
}
