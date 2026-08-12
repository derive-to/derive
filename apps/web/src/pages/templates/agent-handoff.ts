export type AgentTemplateTarget = {
  uri: string
  title: string
  description: string
  kind: "artifact" | "context"
  category: string
  inputs?: ReadonlyArray<{ name: string; description: string; required?: boolean }>
}

const cleanBrief = (brief: string) => brief.trim()

/**
 * The portable contract handed to a person's local agent. It intentionally uses
 * Derive's small, existing MCP vocabulary instead of inventing template-only
 * tools: read the exact reference, find useful evidence, publish a new result.
 */
export const localAgentHandoff = (target: AgentTemplateTarget, brief: string) => {
  const request = cleanBrief(brief)
  if (target.kind === "context")
    return `Use this Derive Context template as a strong reference and make a new version for me.

Template: ${target.title}
Exact reference: ${target.uri}

What I need:
${request}

Work agentically—not as a form fill or a literal clone:
1. Use Derive's read tool to inspect the exact reference before creating anything.
2. Preserve what makes the reference effective, but adapt its manifest, procedures, sources, and operating decisions to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged. Ask only for authority, source, permission, or credential decisions you cannot safely infer.
4. Publish the adapted manifest as a new artifact, then use automate with create_context once the setup is clear.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`

  return `Use this Derive template as a strong reference and make a new artifact for me.

Template: ${target.title}
Exact reference: ${target.uri}

What I need:
${request}

Work agentically—not as a form fill or a literal clone:
1. Use Derive's read tool to inspect the exact reference before creating anything.
2. Preserve what makes the reference effective—its structure, visual language, interactions, and narrative rhythm—but adapt every substantive decision to my brief. Use find when workspace evidence would improve the result.
3. Leave the original unchanged and publish a new artifact with lineage back to the reference.
4. Render and visually inspect the finished result before reporting success. Revise it if the rendered result is weak.
5. Return the new shareable Derive URL and briefly explain the important adaptations.`
}

/** Native beta uses the same product promise. The exact trusted URI is carried
 * separately as template_start, so it never has to appear in the visible chat. */
export const nativeTemplateRequest = (target: AgentTemplateTarget, brief: string) =>
  target.kind === "context"
    ? `Use the ${target.title} template to make this Context ours: ${cleanBrief(brief)}\n\nAdapt the setup to this workspace and ask only for decisions you cannot safely infer. Create the Context when the runner, sources, permissions, and credential bindings are clear, then show me what you set up.`
    : `Use the ${target.title} template to make this mine: ${cleanBrief(brief)}\n\nFind and use relevant evidence from this workspace when it helps. Build a polished first draft, publish it, inspect the rendered result, and show me what you made.`
