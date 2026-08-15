export type AgentTemplateTarget = {
  uri: string
  title: string
  description: string
  kind: "artifact" | "context"
  category: string
  format?: "md" | "html"
  outcome?: string
  sections?: ReadonlyArray<string>
  inputs?: ReadonlyArray<{ name: string; description: string; required?: boolean }>
}

export type AgentHandoffWorkspace = { id: string; name: string }

const cleanBrief = (brief: string) => brief.trim()

/**
 * The portable contract handed to a person's local agent. It intentionally uses
 * Derive's small, existing MCP vocabulary instead of inventing template-only
 * tools: read the exact reference, find useful evidence, publish a new result.
 */
export const localAgentHandoff = (
  target: AgentTemplateTarget,
  brief: string,
  workspace?: AgentHandoffWorkspace,
) => {
  const request = cleanBrief(brief)
  const destination = workspace
    ? `Destination workspace: ${workspace.name} (${workspace.id})\n\n`
    : "\n"
  if (target.kind === "context")
    return `Use this Derive Context template as a strong reference and make a new version for me.

Template: ${target.title}
Exact reference: ${target.uri}
${destination}What I need:
${request}

Work agentically—not as a form fill or a literal clone:
1. Use Derive's find tool once to confirm the active workspace${workspace ? ` is ${workspace.name}` : ""}. Use Derive's read tool to inspect the exact reference before creating anything.
2. Preserve what makes the reference effective, but adapt its manifest, procedures, sources, and operating decisions to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged. Ask only for authority, source, permission, or credential decisions you cannot safely infer.
4. Publish the adapted manifest as a new artifact with \`derived_from: "${target.uri}"\`, then use automate with create_context once the setup is clear.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`

  return `Use this Derive template as a strong reference and make a new artifact for me.

Template: ${target.title}
Exact reference: ${target.uri}
${destination}What I need:
${request}

Work agentically—not as a form fill or a literal clone:
1. Use Derive's find tool once to confirm the active workspace${workspace ? ` is ${workspace.name}` : ""}. Use Derive's read tool to inspect the exact reference before creating anything.
2. Preserve what makes the reference effective—its structure, visual language, interactions, and narrative rhythm—but adapt every substantive decision to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged and publish a new artifact with \`derived_from: "${target.uri}"\` so Derive records the exact reference.
4. Render and visually inspect the finished result before reporting success. Revise it if the rendered result is weak.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`
}
