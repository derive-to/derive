export type ArtifactTemplateFormat = {
  category: "Deck" | "Doc" | "Site"
  label: "Derive deck" | "Markdown" | "HTML"
}

export const artifactTemplateFormat = (
  contentType: string | null | undefined,
): ArtifactTemplateFormat | null => {
  if (contentType === "text/x-derive-deck") return { category: "Deck", label: "Derive deck" }
  if (contentType === "text/markdown") return { category: "Doc", label: "Markdown" }
  if (contentType === "text/html") return { category: "Site", label: "HTML" }
  return null
}
