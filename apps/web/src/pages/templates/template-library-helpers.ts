import type { TemplateLibraryScope } from "@/api"

export const scopeCopy: Record<
  TemplateLibraryScope,
  { label: string; detail: string; icon: "lock" | "following" | "globe" }
> = {
  private: { label: "Only me", detail: "Visible only to you.", icon: "lock" },
  workspace: { label: "Workspace", detail: "Visible to this workspace.", icon: "following" },
  public: { label: "Public", detail: "Discoverable by anyone and MCP.", icon: "globe" },
}

export const matches = (query: string, values: Array<string | undefined>) => {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || values.some((value) => value?.toLocaleLowerCase().includes(needle))
}
