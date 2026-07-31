import { ComposioBroker } from "./composio"
import { LocalBroker } from "./local"
import { type McpAuthResolver, McpBroker, parseMcpRef } from "./mcp"
import { RefusingBroker } from "./refusing"
import type { ToolBroker } from "./types"

export { ComposioBroker } from "./composio"
export { LocalBroker } from "./local"
export type { McpAuthResolver } from "./mcp"
export {
  encodeMcpRef,
  isAllowedOutboundUrl,
  isProviderLegalToolName,
  McpBroker,
  parseMcpRef,
  pinTools,
} from "./mcp"
export { RefusingBroker } from "./refusing"
export type { BrokerConnection, BrokerToolDef, ConnectResult, ToolBroker } from "./types"

/**
 * Build the broker for a resolved broker plan. A Composio plan (the owner's own API key) → the
 * Composio gateway; anything else (no plan, or a local self-host) → the deterministic
 * LocalBroker. The ToolBroker interface is identical either way, so callers never branch on
 * the provider — the whole hosted flow runs on the LocalBroker in dev and tests, and swaps to
 * Composio in production by attaching a broker plan.
 */
export const makeBroker = (
  plan: { provider: string; key: string } | null,
  /** Opt in to the ECHO stub for a workspace with no plan (dev, tests, a self-host kicking the
   *  tyres). Off, a workspace with no broker plan gets a broker that REFUSES.
   *
   *  This defaulted the other way once, and the failure was silent: LocalBroker.execute returns
   *  the caller's own arguments, so a run "reads Stripe", gets its arguments back, and publishes
   *  an artifact full of invented numbers without a single error anywhere. */
  allowEchoStub = false,
): ToolBroker => {
  if (plan?.provider === "composio" && plan.key) return new ComposioBroker(plan.key)
  return allowEchoStub ? new LocalBroker() : new RefusingBroker()
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
 * short enough that nothing is cached across requests. It caches no credentials — `authFor` is
 * consulted per request, so a token revoked a moment ago does not keep working, and an MCP session
 * id belongs to the client-server pair rather than to a tenant.
 *
 * `fallback` is the plan-derived broker (Composio or Local) that every non-MCP ref keeps using.
 * `authFor` resolves the bearer for a ref; omit it for servers that need none.
 */
/** Why a ref contributed no tools, when the broker behind it knows. Only the MCP broker does;
 *  everything else returns undefined, which reads as "no explanation available" rather than
 *  "nothing was wrong". */
export const quietReason = (broker: ToolBroker, ref: string): string | undefined =>
  broker instanceof McpBroker ? broker.quiet.get(ref) : undefined

export const refRouter = (
  fallback: ToolBroker,
  authFor?: McpAuthResolver,
): ((ref: string) => ToolBroker) => {
  const mcp = new McpBroker(undefined, authFor)
  return (ref: string) => (parseMcpRef(ref) ? mcp : fallback)
}
