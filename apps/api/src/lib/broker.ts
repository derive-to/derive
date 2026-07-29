import type { BrokerToolDef, ToolBroker } from "@derive/broker"
import { makeBroker } from "@derive/broker"
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
): Promise<RunTool[]> => {
  if (connectionIds.length === 0) return []
  const conns = await meta.getConnectionsByIds(connectionIds)
  const active = conns.filter((cn) => cn.org_id === orgId && cn.status === "active")
  // A PERSONAL connection acts as its owner, so it must not outlive them: if the owner
  // is no longer a member, the credential stops resolving that instant — same live-
  // membership recheck the minted API tokens do. Workspace connections are the org's
  // and survive any one member leaving.
  const owners = [
    ...new Set(active.filter((cn) => cn.scope === "personal").map((cn) => cn.user_id)),
  ]
  const rows = await Promise.all(owners.map((uid) => meta.getMembership(orgId, uid)))
  const alive = new Set(owners.filter((_, i) => rows[i] !== null))
  const usable = active.filter((cn) => cn.scope === "workspace" || alive.has(cn.user_id))
  const out: RunTool[] = []
  for (const cn of usable) {
    for (const def of await broker.toolsFor([cn.broker_ref])) out.push({ def, ref: cn.broker_ref })
  }
  return out
}

/**
 * The bind-time policy for attaching connections to an automation/context. Returns an
 * error string (for a 400) or null when every id is attachable by this actor:
 *   - every id must exist and live in THIS workspace (never another tenant's);
 *   - a WORKSPACE connection needs a managing actor — otherwise whoever can write an
 *     instruction holds the org's keys, and instructions are the thing agents edit;
 *   - a PERSONAL connection may be attached only by its owner (act-as-me is consensual).
 * `actorUserId` null (a service/agent principal) can therefore bind workspace
 * connections when managing, and never anyone's personal ones.
 */
export const connectionBindError = async (
  meta: MetaStore,
  orgId: string,
  actor: { userId: string | null; canManage: boolean },
  connectionIds: string[],
): Promise<string | null> => {
  if (connectionIds.length === 0) return null
  const conns = await meta.getConnectionsByIds(connectionIds)
  if (conns.length !== connectionIds.length || conns.some((cn) => cn.org_id !== orgId))
    return "connections must exist in this workspace"
  for (const cn of conns) {
    if (cn.scope === "workspace") {
      if (!actor.canManage) return `attaching workspace connection "${cn.toolkit}" needs manage`
    } else if (!actor.userId || cn.user_id !== actor.userId) {
      return `personal connection "${cn.toolkit}" can only be attached by its owner`
    }
  }
  return null
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
