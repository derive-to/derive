import type { BrokerToolDef, ToolBroker } from "@derive/broker"
import { makeBroker, refRouter } from "@derive/broker"
import type { MetaStore } from "@derive/core"
import { decryptSecret } from "./crypto"

/** One tool a hosted run may call, paired with the connected-account ref it executes through. */
export interface RunTool {
  def: BrokerToolDef
  ref: string
}

/**
 * WO4 — the least-privilege tool set for a hosted run. Given the run's BOUND connection ids,
 * resolve ONLY those connections (never the workspace's whole list), keep the ones that are
 * ACTIVE and in THIS org, and expose each connection's broker tools paired with its ref. A run
 * bound to a Stripe connection can therefore see Stripe tools and nothing else — a Gmail
 * connection it did not bind contributes zero tools.
 */
export const toolsForRun = async (
  meta: MetaStore,
  broker: ToolBroker,
  orgId: string,
  connectionIds: string[],
  /** An optional SHARED ref router. Pass one when resolving several runs in a single request (a
   *  claim), so every run's MCP lookups reuse one client and one set of sessions instead of
   *  re-handshaking per run. Omitted, each call gets its own. */
  router?: (ref: string) => ToolBroker,
): Promise<RunTool[]> => {
  if (connectionIds.length === 0) return []
  const conns = await meta.getConnectionsByIds(connectionIds)
  const active = conns.filter((cn) => cn.org_id === orgId && cn.status === "active")
  // Per-CONNECTION routing through ONE router: an `mcp:` ref reaches the MCP broker whatever the
  // workspace's broker plan is (it needs no vendor account at all), everything else keeps the
  // plan's broker. Sharing the router across this resolution is what lets the MCP client reuse
  // its session instead of re-handshaking per connection.
  const route = router ?? refRouter(broker)
  const out: RunTool[] = []
  // Dedupe by ref before listing. Two connection rows can point at the same broker_ref (the same
  // MCP server bound twice, a re-connect that kept the ref), and listing it twice is two extra
  // network round trips for a set of tools we already have.
  const seen = new Set<string>()
  for (const cn of active) {
    if (seen.has(cn.broker_ref)) continue
    seen.add(cn.broker_ref)
    // One unreachable or hostile server must not take down the whole tool list: a run bound to
    // three connections still gets the other two, and sees the failure as a missing tool rather
    // than a failed claim.
    const defs = await route(cn.broker_ref)
      .toolsFor([cn.broker_ref])
      .catch(() => [])
    for (const def of defs) out.push({ def, ref: cn.broker_ref })
  }
  return out
}

/**
 * Build the tool broker for a workspace: the owner's Composio broker plan (its OWN key) if one
 * is attached, else the deterministic LocalBroker. `ownerUserId` scopes plan resolution
 * (personal → workspace pool). The LocalBroker runs the whole hosted flow with no external
 * dependency, so dev and tests never need a vendor account.
 */
export const brokerFor = async (
  meta: MetaStore,
  orgId: string,
  ownerUserId: string | null,
  encryptionKey: string | undefined,
): Promise<ToolBroker> => {
  const plan = await meta.resolvePlan(orgId, ownerUserId, "broker")
  if (plan && encryptionKey) {
    return makeBroker({
      provider: plan.provider,
      key: decryptSecret(plan.secret_enc, encryptionKey),
    })
  }
  return makeBroker(null)
}
