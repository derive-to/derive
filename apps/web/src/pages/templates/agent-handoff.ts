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
  /** Set for a public-shelf artifact from another workspace: the agent's MCP grant may
   *  not reach it by short id, but its page is world-readable (and serves markdown). */
  publicUrl?: string
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

Use the template as a reference, then make the decisions this brief needs:
1. Use Derive's find tool once to confirm the active workspace${workspace ? ` is ${workspace.name}` : ""}. Use Derive's read tool to inspect the exact reference before creating anything.
2. Preserve what makes the reference effective, but adapt its manifest, procedures, sources, and operating decisions to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged. Ask only for authority, source, permission, or credential decisions you cannot safely infer.
4. Publish the adapted manifest as a new artifact with \`derived_from: "${target.uri}"\`, then use automate with create_context once the setup is clear.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`

  // A public-shelf artifact from another workspace: the agent's grant may not reach it by
  // short id, but its page is world-readable and serves markdown, so the reference is the
  // URL and lineage is left out rather than promised and refused.
  if (target.publicUrl)
    return `Use this public Derive artifact as a strong reference and make a new artifact for me.

Template: ${target.title}
Exact reference: ${target.publicUrl}
${destination}What I need:
${request}

Use the template as a reference, then make the decisions this brief needs:
1. Use Derive's find tool once to confirm the active workspace${workspace ? ` is ${workspace.name}` : ""}. Fetch the exact reference URL (it serves markdown to agents) before creating anything; it is outside this workspace, so Derive's read tool may not reach it.
2. Keep the useful structure, visual language, interactions, and narrative rhythm. Adapt the content and other decisions to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged and publish a new artifact. Do not set derived_from: lineage to an artifact outside this workspace is not recorded yet.
4. Render and visually inspect the finished result before reporting success. Revise it if the rendered result is weak.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`

  return `Use this Derive template as a strong reference and make a new artifact for me.

Template: ${target.title}
Exact reference: ${target.uri}
${destination}What I need:
${request}

Use the template as a reference, then make the decisions this brief needs:
1. Use Derive's find tool once to confirm the active workspace${workspace ? ` is ${workspace.name}` : ""}. Use Derive's read tool to inspect the exact reference before creating anything.
2. Keep the useful structure, visual language, interactions, and narrative rhythm. Adapt the content and other decisions to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged and publish a new artifact with \`derived_from: "${target.uri}"\` so Derive records the exact reference.
4. Render and visually inspect the finished result before reporting success. Revise it if the rendered result is weak.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`
}
