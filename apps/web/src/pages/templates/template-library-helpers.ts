import type { TemplateLibraryScope } from "@/api"

export const scopeCopy: Record<
  TemplateLibraryScope,
  { label: string; detail: string; icon: "lock" | "following" | "globe" }
> = {
  private: { label: "Only me", detail: "Visible only to you.", icon: "lock" },
  workspace: { label: "Workspace", detail: "Visible to this workspace.", icon: "following" },
  public: { label: "Public", detail: "Discoverable by anyone and MCP.", icon: "globe" },
}

export const csv = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

// One line per input; a leading * marks the input as required.
export const inputsFromLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const required = line.startsWith("*")
      const [name = "", ...description] = (required ? line.slice(1) : line)
        .split(/\s*(?:—|–|:)\s*/)
        .map((part) => part.trim())
      return {
        name,
        description: description.join(" — ") || "Use this before drafting.",
        required,
      }
    })
    .filter((input) => input.name)

export const matches = (query: string, values: Array<string | undefined>) => {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || values.some((value) => value?.toLocaleLowerCase().includes(needle))
}
