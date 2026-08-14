import { BUILT_IN_TEMPLATES } from "./catalog"
import { renderTemplate } from "./render"
import { BUILT_INS_LIBRARY_ID, TEMPLATE_CATALOG_VERSION, type TemplateResource } from "./types"

export const TEMPLATE_RESOURCE_SCHEMA_VERSION = 1
export const TEMPLATE_CATALOG_URI = "derive://templates/catalog"

const stableJson = (value: unknown) => JSON.stringify(value, null, 2)

const summaryOf = (template: (typeof BUILT_IN_TEMPLATES)[number]) => ({
  library_id: template.libraryId,
  template_id: template.id,
  catalog_version: template.catalogVersion,
  kind: template.kind,
  category: template.category,
  format: template.format,
  title: template.title,
  default_title: template.defaultTitle,
  description: template.description,
  outcome: template.outcome,
  sections: template.sections,
  inputs: template.inputs,
  tags: template.tags,
  uri: `derive://templates/${template.id}`,
})

export function catalogResource(): TemplateResource {
  const artifactCount = BUILT_IN_TEMPLATES.filter((template) => template.kind === "artifact").length
  const contextCount = BUILT_IN_TEMPLATES.length - artifactCount
  return {
    uri: TEMPLATE_CATALOG_URI,
    title: "Derive built-in Templates",
    description: `${BUILT_IN_TEMPLATES.length} curated starts: ${artifactCount} artifact Templates and ${contextCount} safe Context manifests. Read an entry resource for its exact starter source, then use publish to create an independent artifact.`,
    mimeType: "application/json",
    text: stableJson({
      schema_version: TEMPLATE_RESOURCE_SCHEMA_VERSION,
      catalog_version: TEMPLATE_CATALOG_VERSION,
      library: {
        id: BUILT_INS_LIBRARY_ID,
        title: "Derive built-ins",
        visibility: "public",
        release: TEMPLATE_CATALOG_VERSION,
      },
      counts: {
        artifacts: artifactCount,
        contexts: contextCount,
      },
      templates: BUILT_IN_TEMPLATES.map(summaryOf),
    }),
  }
}

export function templateResource(id: string | undefined): TemplateResource | undefined {
  const draft = renderTemplate(id)
  if (!draft) return undefined
  const { template } = draft
  return {
    uri: `derive://templates/${template.id}`,
    title: template.title,
    description: template.description,
    mimeType: "application/json",
    text: stableJson({
      schema_version: TEMPLATE_RESOURCE_SCHEMA_VERSION,
      template: summaryOf(template),
      starter: {
        filename: draft.filename,
        mime_type: draft.mimeType,
        title: draft.title,
        message: draft.message,
        source: draft.source,
      },
      provenance: {
        library_id: draft.origin.libraryId,
        template_id: draft.origin.templateId,
        catalog_version: draft.origin.catalogVersion,
        note: "The published result is an independent artifact; this Template never remains a live dependency.",
      },
      context_safety:
        template.kind === "context"
          ? "This is a portable manifest only. Bind runners, sources, approvals, and credentials after publishing; never place them in template source."
          : undefined,
    }),
  }
}
