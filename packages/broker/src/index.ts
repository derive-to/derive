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
 * Route by CONNECTION, not by workspace plan — and reuse ONE MCP client while doing it.
 *
 * An MCP connection carries its own server URL in its ref and needs no vendor account, so it has
 * to work in a workspace with no broker plan at all, which is every workspace today. Routing on
 * the ref also lets one workspace hold MCP connections and a Composio plan at once, each
 * reaching the right implementation.
 *
 * Returns a ROUTER rather than resolving one ref, because the instance matters. McpBroker keeps a
 * URL → session-id map, and MCP's streamable HTTP transport lets a client skip `initialize` once
 * it holds a session. Constructing a fresh broker per ref threw that map away every time, so
 * every single tool listing paid `initialize` + `tools/list` instead of just `tools/list` —
 * double the round trips, on the path a code-mode script hits hardest.
 *
 * One router per REQUEST is the intended lifetime: long enough for a claim resolving several
 * runs, or a tool call validating against several bound servers, to share sessions and the memo;
 * short enough that nothing is cached across requests. It holds no credentials — an MCP session
 * id belongs to the client-server pair, not to a tenant.
 *
 * `fallback` is the plan-derived broker (Composio or Local) that every non-MCP ref keeps using.
 */
export const refRouter = (fallback: ToolBroker): ((ref: string) => ToolBroker) => {
  const mcp = new McpBroker()
  return (ref: string) => (parseMcpRef(ref) ? mcp : fallback)
}
