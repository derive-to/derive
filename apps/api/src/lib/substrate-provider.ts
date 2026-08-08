import type { ExecutionProvider } from "@derive/core"
import type { Substrate } from "./dispatch"

/**
 * Route selected coding-agent work to a machine substrate while keeping ordinary model turns on
 * the cheap in-process loop. A missing selected substrate is a boot refusal: dispatch leaves the
 * run queued instead of quietly executing it with a different provider.
 */
export const providerSubstrate = (input: {
  fallback: Substrate
  providers: Partial<Record<ExecutionProvider, Substrate>>
}): Substrate => ({
  name: `provider-router(${input.fallback.name})`,
  async start(work) {
    const provider = work.execution?.provider
    if (!provider) return input.fallback.start(work)
    const selected = input.providers[provider]
    if (selected) return selected.start(work)
    if (provider === "claude-code") return input.fallback.start(work)
    throw new Error(`no hosted substrate is configured for ${provider}`)
  },
})
