import type { BrokerToolDef, ToolBroker } from "@derive/broker"
import { makeBroker } from "@derive/broker"
import type { ConnectionRecord, MetaStore } from "@derive/core"
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
    // A secret connection has no vendor: Derive itself is the executor, so its tool
    // defs are emitted here and its calls are handled by executeSecretTool — the
    // broker never sees the ref and the credential never leaves the server.
    if (cn.kind === "secret") {
      for (const def of secretTools(cn.toolkit)) out.push({ def, ref: cn.broker_ref })
      continue
    }
    for (const def of await broker.toolsFor([cn.broker_ref])) out.push({ def, ref: cn.broker_ref })
  }
  return out
}

/** The tool pair a pasted-secret connection exposes: HTTP against its base_url, executed
 *  server-side with the decrypted secret as a bearer. Names mirror the broker's
 *  `<toolkit>.<verb>` convention so the shim treats both kinds identically. */
export const secretTools = (toolkit: string): BrokerToolDef[] => [
  {
    name: `${toolkit}.get`,
    description: `GET a path on the ${toolkit} API (authenticated server-side).`,
    params: { path: { type: "string", description: "Path starting with /" } },
  },
  {
    name: `${toolkit}.post`,
    description: `POST JSON to a path on the ${toolkit} API (authenticated server-side).`,
    params: { path: { type: "string" }, body: { type: "object" } },
  },
]

/**
 * Execute one tool call for a pasted-secret connection: join the requested path against
 * the connection's base_url, CONFINE the result to that base (no absolute URLs, no
 * traversal out of the prefix — a hostile path must not aim the credential at another
 * host or another route family), attach the secret as a bearer, and return status+body.
 * The caller has already verified the tool is on the run's least-privilege list.
 */
export const executeSecretTool = async (
  cn: ConnectionRecord,
  tool: string,
  args: unknown,
  encryptionKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> => {
  if (!cn.secret_enc || !cn.base_url) throw new Error("secret connection is missing its secret")
  const a = (args ?? {}) as { path?: unknown; body?: unknown }
  const path = typeof a.path === "string" ? a.path : ""
  if (!path.startsWith("/")) throw new Error("path must start with /")
  const base = new URL(`${cn.base_url}/`)
  const url = new URL(`.${path}`, base) // "." pins resolution under base even for hostile paths
  if (url.origin !== base.origin || !url.href.startsWith(cn.base_url))
    throw new Error("path escapes the connection's base_url")
  const verb = tool.endsWith(".post") ? "POST" : "GET"
  const res = await fetchImpl(url.href, {
    method: verb,
    headers: {
      authorization: `Bearer ${decryptSecret(cn.secret_enc, encryptionKey)}`,
      ...(verb === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: verb === "POST" ? JSON.stringify(a.body ?? {}) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Non-JSON responses ride through as text.
  }
  return { status: res.status, body }
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
