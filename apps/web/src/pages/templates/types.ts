/** Libraries get no tab until someone creates one; `?tab=libraries` still reaches them. */
export const TEMPLATE_LIBRARIES_ENABLED = false

export type TemplateTab = "artifacts" | "libraries"

export type TemplatesSearch = {
  tab?: TemplateTab
  query?: string
  derive?: boolean
  source?: string
  library?: string
}

export type NewArtifactSearch = {
  start?: "deck" | "skill"
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
