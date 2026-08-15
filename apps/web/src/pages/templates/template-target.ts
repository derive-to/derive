import type { Artifact, TemplateLibraryEntry } from "@/api"
import type { AgentTemplateTarget } from "./agent-handoff"
import { artifactTemplateFormat } from "./artifact-template-format"
import type { BuiltInTemplate } from "./types"

const artifactCategory = (artifact: Artifact): string =>
  artifactTemplateFormat(artifact.current_content_type)?.category ?? "Artifact"

export const targetFromBuiltIn = (template: BuiltInTemplate): AgentTemplateTarget => ({
  uri: `derive://templates/${template.id}`,
  title: template.title,
  description: template.description,
  kind: template.kind,
  category: template.category,
  format: template.format,
  outcome: template.outcome,
  sections: template.sections,
  inputs: template.inputs,
})

export const targetFromArtifact = (artifact: Artifact): AgentTemplateTarget => ({
  uri: artifact.short_id,
  title: artifact.title || "Untitled artifact",
  description: "A new, agent-authored result grounded in this artifact.",
  kind: "artifact",
  category: artifactCategory(artifact),
})

export const targetFromLibraryEntry = (
  libraryId: string,
  entry: TemplateLibraryEntry,
): AgentTemplateTarget => ({
  uri: `derive://template-libraries/${libraryId}/${entry.id}`,
  title: entry.title,
  description: entry.description,
  kind: entry.kind,
  category: entry.category,
  format: entry.format,
  outcome: entry.outcome,
  sections: entry.sections,
  inputs: entry.inputs,
})
