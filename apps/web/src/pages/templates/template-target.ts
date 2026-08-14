import type { Artifact, TemplateLibraryEntry } from "@/api"
import type { AgentTemplateTarget } from "./agent-handoff"
import type { BuiltInTemplate } from "./types"

const artifactCategory = (artifact: Artifact): string =>
  artifact.current_content_type === "text/x-derive-deck"
    ? "Deck"
    : artifact.current_content_type === "text/markdown"
      ? "Doc"
      : "Site"

export const targetFromBuiltIn = (template: BuiltInTemplate): AgentTemplateTarget => ({
  uri: `derive://templates/${template.id}`,
  title: template.title,
  description: template.description,
  kind: template.kind,
  category: template.category,
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
  inputs: entry.inputs,
})
