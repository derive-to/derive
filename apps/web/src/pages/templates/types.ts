export type { TemplateArtifact } from "@/api"

/**
 * Authored libraries stay reachable by deep link (`?tab=libraries`) but get no tab
 * while nobody has created one. Flip this when the shelf earns a second surface.
 */
export const TEMPLATE_LIBRARIES_ENABLED = false

export type TemplateTab = "artifacts" | "libraries"

export type TemplatesSearch = {
  tab?: TemplateTab
  query?: string
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
