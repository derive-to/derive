import type { Artifact, TemplateLibraryEntry } from "@/api"
import type { AgentTemplateTarget } from "./agent-handoff"
import { artifactTemplateFormat } from "./artifact-template-format"

const artifactCategory = (artifact: Pick<Artifact, "current_content_type">): string =>
  artifactTemplateFormat(artifact.current_content_type)?.category ?? "Artifact"

export const targetFromArtifact = (
  artifact: Pick<Artifact, "short_id" | "title" | "current_content_type">,
): AgentTemplateTarget => ({
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
