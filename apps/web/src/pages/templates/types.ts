import type { components } from "@/api-types"

export type BuiltInTemplate = components["schemas"]["BuiltInTemplate"]
export type TemplateCategory = BuiltInTemplate["category"]

export type TemplateTab = "artifacts" | "contexts" | "libraries"

export type TemplatesSearch = {
  tab?: TemplateTab
  query?: string
  category?: TemplateCategory
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
