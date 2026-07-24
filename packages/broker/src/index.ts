import { ComposioBroker } from "./composio"
import { LocalBroker } from "./local"
import type { ToolBroker } from "./types"

export { ComposioBroker } from "./composio"
export { LocalBroker } from "./local"
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
