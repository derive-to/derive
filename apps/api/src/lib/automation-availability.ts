import type { AgentRecord, ExecutionProvider, OrgSettings } from "@derive/core"

export interface HostedAutomationConfig {
  providers: readonly ExecutionProvider[]
  /** Undefined leaves self-hosted deployments unrestricted; an empty set admits nobody. */
  workspaceIds?: ReadonlySet<string>
}

export const hostedWorkspaceAllowed = (ids: ReadonlySet<string> | undefined, orgId: string) =>
  ids === undefined || ids.has(orgId)

/** Deployment admission and workspace consent, shared by preflight and run creation.
 * Undefined means an owner-operated polling runner; null means hosted execution is ready. */
export const automationRunBlocker = (
  config: HostedAutomationConfig | undefined,
  orgId: string,
  settings: OrgSettings,
  provider: ExecutionProvider,
  agent?: Pick<AgentRecord, "hosted" | "managed"> | null,
): string | null | undefined => {
  // Explicit service agents retain their owner-operated polling runner. Managed task
  // identities rely on hosted execution, even before their first runner heartbeat.
  if (!config || (agent?.managed === 0 && agent.hosted === 0)) return undefined
  if (!hostedWorkspaceAllowed(config.workspaceIds, orgId))
    return "Hosted execution is not available for this workspace. An instance operator must enable it."
  if (!config.providers.includes(provider))
    return `No hosted ${provider === "codex" ? "Codex" : "Claude"} runner is configured on this instance.`
  if (!settings.hostedAgentsEnabled) return "Hosted agents are disabled in workspace settings."
  if (!settings.agentWrites) return "Agent writes are paused in workspace settings."
  return null
}
