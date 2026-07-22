import type { MastraLanguageModel } from "@mastra/core/agent"
import { Agent } from "@mastra/core/agent"
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
  /** The per-run context: the client (bearer-authed), run latch, autonomy + flags. */
  run: RunContext
  /** The model instance, wired by the host (Vercel AI SDK model). */
  model: MastraLanguageModel
}

const CONTRACT = `

You maintain and draft Derive artifacts. Read before you write. When you have the
complete revised source, call submit_revision exactly once with the FULL new
content and your honest confidence — Derive decides how it lands (a review round,
a proposal, or a recorded shadow); that is never your call. Do not describe the
change instead of submitting it.`

export function buildInstructions(
  input: Pick<HostedAgentInput, "manifest" | "conventions">,
): string {
  return `${input.manifest}${input.conventions ? `\n\n${input.conventions}` : ""}${CONTRACT}`
}

/** Build a fresh Mastra agent for one invocation. One agent, one run latch. */
export function createHostedAgent(input: HostedAgentInput): Agent {
  return new Agent({
    id: "derive-hosted-agent",
    name: "Derive hosted agent",
    instructions: buildInstructions(input),
    model: input.model,
    tools: buildTools(input.run),
  })
}
