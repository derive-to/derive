import type { MastraLanguageModel } from "@mastra/core/agent"
import { Agent } from "@mastra/core/agent"
import type { createTool } from "@mastra/core/tools"
import { buildTools, type RunContext } from "./tools"

// The Mastra hosted-agent. Instructions are assembled from the SAME manifest +
// Brandprint the runner materializes (single source of truth), the tools wrap
// the public surface as this agent's principal, and the MODEL is supplied by the
// host — the package never imports a provider SDK, so the model choice (and Q4's
// provider neutrality) lives in the host's config, not here.

export interface HostedAgentInput {
  /** The manifest body — the agent's system prompt, exactly as the runner uses it. */
  manifest: string
  /** Optional Brandprint conventions block (materialized notes/skills summary). */
  conventions?: string
  /** The per-run context: the client (bearer-authed), write budget, autonomy + flags. */
  run: RunContext
  /** The model instance, wired by the host (Vercel AI SDK model). */
  model: MastraLanguageModel
  /** The run's SOURCE tools (from its bound connections), already wrapped by buildBrokerTools.
   *  Merged alongside the built-in artifact tools so a pull run can fetch from its sources; empty
   *  for automations that bind none. Built-ins win a name collision — the artifact surface is
   *  never shadowed by a source tool. */
  extraTools?: Record<string, ReturnType<typeof createTool>>
}

const CONTRACT = `

You maintain and draft Derive artifacts. Read before you write. When you have the
complete source, call submit_revision exactly once per piece of work — pass shortId
to revise a target artifact, omit it (with a title) to create a new one when the
task asks for that — with the FULL content and your honest confidence. Derive
decides how each write lands (a review round, a proposal, or a recorded shadow);
that is never your call. A small per-run write budget applies: prefer one write.
Do not describe the change instead of submitting it.`

export function buildInstructions(
  input: Pick<HostedAgentInput, "manifest" | "conventions">,
): string {
  return `${input.manifest}${input.conventions ? `\n\n${input.conventions}` : ""}${CONTRACT}`
}

/** Build a fresh Mastra agent for one invocation. One agent, one write budget. */
export function createHostedAgent(input: HostedAgentInput): Agent {
  return new Agent({
    id: "derive-hosted-agent",
    name: "Derive hosted agent",
    instructions: buildInstructions(input),
    model: input.model,
    // Built-ins last so an artifact tool always wins a name collision with a source tool.
    tools: { ...input.extraTools, ...buildTools(input.run) },
  })
}
