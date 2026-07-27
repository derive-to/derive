import { ComposioBroker } from "./composio"
import { LocalBroker } from "./local"
import { McpBroker, parseMcpRef } from "./mcp"
import type { ToolBroker } from "./types"

export { ComposioBroker } from "./composio"
export { LocalBroker } from "./local"
export { encodeMcpRef, McpBroker, parseMcpRef, pinTools } from "./mcp"
export type { BrokerConnection, BrokerToolDef, ConnectResult, ToolBroker } from "./types"

/**
 * Build the broker for a resolved broker plan. A Composio plan (the owner's own API key) → the
 * Composio gateway; anything else (no plan, or a local self-host) → the deterministic
 * LocalBroker. The ToolBroker interface is identical either way, so callers never branch on
 * the provider — the whole hosted flow runs on the LocalBroker in dev and tests, and swaps to
 * Composio in production by attaching a broker plan.
 */
export const makeBroker = (plan: { provider: string; key: string } | null): ToolBroker => {
  if (plan?.provider === "composio" && plan.key) return new ComposioBroker(plan.key)
  return new LocalBroker()
}

/**
 * Route by CONNECTION, not by workspace plan.
 *
 * An MCP connection carries its own server URL in its ref and needs no vendor account, so it has
 * to work in a workspace with no broker plan at all — which is every workspace today. Routing on
 * the ref also lets one workspace hold MCP connections and a Composio plan at the same time,
 * each reaching the right implementation, instead of a single global choice deciding for all of
 * them.
 *
 * `fallback` is the plan-derived broker (Composio or Local) that every non-MCP ref keeps using.
 */
export const brokerForRef = (ref: string, fallback: ToolBroker): ToolBroker =>
  parseMcpRef(ref) ? new McpBroker() : fallback
