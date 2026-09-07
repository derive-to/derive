export type ArtifactTemplateFormat = {
  category: "Deck" | "Doc" | "Site" | "Paper"
  label: "Derive deck" | "Markdown" | "HTML" | "LaTeX"
}

export const artifactTemplateFormat = (
  contentType: string | null | undefined,
): ArtifactTemplateFormat | null => {
  if (contentType === "text/x-derive-deck") return { category: "Deck", label: "Derive deck" }
  if (contentType === "text/markdown") return { category: "Doc", label: "Markdown" }
  if (contentType === "text/x-latex") return { category: "Paper", label: "LaTeX" }
  if (contentType === "text/html") return { category: "Site", label: "HTML" }
  return null
}
