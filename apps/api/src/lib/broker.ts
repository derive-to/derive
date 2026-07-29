import type { BrokerToolDef, ToolBroker } from "@derive/broker"
import { makeBroker } from "@derive/broker"
import type { ConnectionKind, ConnectionRecord, MetaStore } from "@derive/core"
import { decryptSecret } from "./crypto"

/** One tool a hosted run may call, paired with the connected-account ref it executes through.
 *  `kind` and `connectionId` are how the tool proxy routes the call without a second lookup;
 *  the connection RECORD is deliberately not here — it carries secret_enc, and this struct
 *  flows toward the claim response. */
export interface RunTool {
  def: BrokerToolDef
  ref: string
  kind: ConnectionKind
  connectionId: string
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
  // A personal connection acts as its owner, so it must not outlive them: an offboarded
  // member's credential stops resolving on the next run, the same live-membership recheck
  // a minted API token gets at spend time. Workspace connections are the org's and survive.
  const owners = [...new Set(active.filter((cn) => cn.scope === "personal").map((c) => c.user_id))]
  const seats = await Promise.all(
    owners.map(async (uid) => [uid, await meta.getMembership(orgId, uid)] as const),
  )
  const stillMembers = new Set(seats.filter(([, seat]) => seat !== null).map(([uid]) => uid))
  const usable = active.filter((cn) => cn.scope === "workspace" || stillMembers.has(cn.user_id))
  const out: RunTool[] = []
  for (const cn of usable) {
    const entry = { ref: cn.broker_ref, kind: cn.kind, connectionId: cn.id }
    // A secret connection has no vendor account, so its tools are ours to declare and
    // ours to execute (see executeSecretTool); the broker is never asked about it.
    const defs =
      cn.kind === "secret" ? secretTools(cn.toolkit) : await broker.toolsFor([cn.broker_ref])
    for (const def of defs) out.push({ def, ...entry })
  }
  return out
}

/** The tools a pasted-secret connection exposes. Named `<toolkit>.<verb>` to match the
 *  broker's convention, so the runner's shim treats both kinds of connection identically. */
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
 * Execute one tool call for a pasted-secret connection: resolve the requested path under
 * the connection's base_url, attach the decrypted credential, return status + body. The
 * caller has already verified the tool is on this run's least-privilege list.
 *
 * The path is attacker-influenced (it comes from the model, which may have read hostile
 * content), so confinement is the load-bearing part: the credential must only ever be
 * offered to the base it was pasted for. Two things do that work — resolving as `.<path>`
 * makes `..` climb out of the base instead of escaping the parser, and the containment
 * check compares against base.href WITH its trailing slash, so a base of `/admin` cannot
 * be satisfied by `/administrator` (string-prefix matching without the slash accepts it).
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
  const url = new URL(`.${path}`, base)
  if (!url.href.startsWith(base.href)) throw new Error("path escapes the connection's base_url")
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
 * The bind-time policy for attaching connections to an automation or context. Returns the
 * 400 message, or null when every id is attachable by this actor:
 *   - the id exists and belongs to THIS workspace (never another tenant's);
 *   - a workspace connection needs a managing actor — otherwise anyone who can write an
 *     instruction holds the org's keys, and instructions are what agents edit;
 *   - a personal connection binds only for its owner, since act-as-me is consensual.
 * An actor with no user id (an agent principal acting for no one) can bind workspace
 * connections when managing, and nobody's personal ones.
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
