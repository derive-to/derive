import type { BrokerToolDef, ToolBroker } from "@derive/broker"
import { type McpAuthResolver, makeBroker, refRouter } from "@derive/broker"
import type { ConnectionKind, ConnectionRecord, MetaStore } from "@derive/core"
import { decryptSecret } from "./crypto"
import { installationToken } from "./github-app"

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
  /** An optional SHARED ref router. Pass one when resolving several runs in a single request (a
   *  claim), so every run's MCP lookups reuse one client and one set of sessions instead of
   *  re-handshaking per run. Omitted, each call gets its own. */
  router?: (ref: string) => ToolBroker,
  /** Needed only to decrypt an MCP connection's bearer. Omitted, MCP servers that require
   *  authentication simply contribute no tools rather than being called without a credential. */
  encryptionKey?: string,
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
  // Per-CONNECTION routing through ONE router: an `mcp:` ref reaches the MCP broker whatever the
  // workspace's broker plan is (it needs no vendor account at all), everything else keeps the
  // plan's broker. Sharing the router across this resolution is what lets the MCP client reuse
  // its session instead of re-handshaking per connection.
  const route = router ?? refRouter(broker, mcpAuthFor(meta, orgId, encryptionKey))
  const out: RunTool[] = []
  // Dedupe by ref before listing. Two connection rows can point at the same broker_ref (the same
  // MCP server bound twice, a re-connect that kept the ref), and listing it twice is two extra
  // network round trips for a set of tools we already have.
  const seen = new Set<string>()
  for (const cn of usable) {
    if (seen.has(cn.broker_ref)) continue
    seen.add(cn.broker_ref)
    const entry = { ref: cn.broker_ref, kind: cn.kind, connectionId: cn.id }
    // A direct connection has no vendor account, so its tools are ours to declare and
    // ours to execute (see executeHttpTool); the broker is never asked about it.
    //
    // One unreachable or hostile server must not take down the whole tool list: a run bound to
    // three connections still gets the other two, and sees the failure as a missing tool rather
    // than a failed claim.
    const defs = isDirect(cn.kind)
      ? httpTools(cn.toolkit)
      : await route(cn.broker_ref)
          .toolsFor([cn.broker_ref])
          .catch(() => [])
    for (const def of defs) out.push({ def, ...entry })
  }
  return out
}

/** Kinds Derive authenticates and calls itself, rather than handing to the broker. They
 *  differ only in where the bearer comes from (see bearerFor) — the HTTP call is identical.
 *
 *  Enumerated rather than `!== "oauth"`: this gates whether we spend a credential ourselves
 *  and whether a revoke reaches a vendor, so a kind added later must fail into the broker
 *  path (which refuses an unknown ref) instead of silently into ours. */
const DIRECT_KINDS = new Set<ConnectionKind>(["secret", "github_app", "slack"])
export const isDirect = (kind: ConnectionKind): boolean => DIRECT_KINDS.has(kind)

/**
 * The bearer resolver an MCP client uses, built from the connections already in hand.
 *
 * Keyed by REF rather than by URL, because two connections can point at the same server with
 * different credentials — a personal one per member, say — and resolving by URL would hand one
 * member's run the other member's token.
 *
 * Decrypts at CALL time, never at bind time, and never stores the plaintext on anything that
 * outlives the call. Same rule as `bearerFor`: a credential revoked a second ago must stop
 * working now, not whenever something happens to re-read it.
 */
export const mcpAuthFor = (
  meta: MetaStore,
  orgId: string,
  encryptionKey: string | undefined,
): McpAuthResolver => {
  // Fetched at most once per router, and only if an MCP ref is actually reached — a workspace
  // with no MCP connection pays nothing. Memoised on the promise so concurrent refs share it.
  let all: Promise<ConnectionRecord[]> | null = null
  return async (target: string) => {
    if (!encryptionKey || !target.startsWith("mcp:")) return undefined
    all ??= meta.listConnections(orgId)
    const cn = (await all).find((x) => x.broker_ref === target && x.secret_enc)
    return cn?.secret_enc ? decryptSecret(cn.secret_enc, encryptionKey) : undefined
  }
}

/** The tools a direct connection exposes. Named `<toolkit>.<verb>` to match the broker's
 *  convention, so the runner's shim treats every kind of connection identically. */
export const httpTools = (toolkit: string): BrokerToolDef[] => [
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
 * The bearer for a direct connection, resolved at CALL time — never at bind time, and never
 * stored on the RunTool. Each kind answers the same question from a different place:
 *
 *   secret      the pasted credential, decrypted here
 *   github_app  a short-lived installation token, minted per call (cached ~1h) against the
 *               App install that repo sync already uses — so nothing long-lived exists to leak
 *   slack       the workspace's bot token from its existing install
 *
 * Throws when the underlying install is gone (uninstalled, revoked): the connection outlives
 * its integration as a row, and this is where that surfaces as a refusal rather than a call
 * with no credential.
 */
export const bearerFor = async (
  meta: MetaStore,
  cn: ConnectionRecord,
  encryptionKey: string,
): Promise<string> => {
  if (cn.kind === "secret") {
    if (!cn.secret_enc) throw new Error("secret connection is missing its secret")
    return decryptSecret(cn.secret_enc, encryptionKey)
  }
  if (cn.kind === "github_app") {
    const app = await meta.getGithubApp()
    if (!app) throw new Error("the GitHub App is not configured on this instance")
    return installationToken(
      app.app_id,
      decryptSecret(app.private_key, encryptionKey),
      cn.broker_ref,
    )
  }
  if (cn.kind === "slack") {
    const install = await meta.getSlackInstall(cn.org_id)
    if (!install) throw new Error("Slack is no longer connected to this workspace")
    if (install.needs_reauth === 1) throw new Error("the Slack install needs to be reconnected")
    return decryptSecret(install.bot_token, encryptionKey)
  }
  throw new Error(`connection kind ${cn.kind} has no direct credential`)
}

/**
 * Execute one tool call for a direct connection: resolve the requested path under the
 * connection's base_url, attach its bearer, return status + body. The caller has already
 * verified the tool is on this run's least-privilege list.
 *
 * The path is attacker-influenced (it comes from the model, which may have read hostile
 * content), so confinement is the load-bearing part: the credential must only ever be
 * offered to the base it was registered for. Two things do that work — resolving as
 * `.<path>` makes `..` climb out of the base instead of escaping the parser, and the
 * containment check compares against base.href WITH its trailing slash, so a base of
 * `/admin` cannot be satisfied by `/administrator` (a bare prefix test accepts it).
 */
export const executeHttpTool = async (
  meta: MetaStore,
  cn: ConnectionRecord,
  tool: string,
  args: unknown,
  encryptionKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> => {
  if (!cn.base_url) throw new Error("connection is missing its base_url")
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
      authorization: `Bearer ${await bearerFor(meta, cn, encryptionKey)}`,
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

/** A connection-id list as stored (a JSON array in a text column), parsed defensively: a
 *  hand-edited or truncated row yields no tools rather than 500ing the lane that read it.
 *  Both the automation column and the context column carry this shape. */
export const parseConnectionIds = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** What a proxied tool call resolved to: the result, or the status + message the route
 *  should return. A shared shape so the two lanes can't drift on what a call means. */
export type ToolCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: 403 | 404 | 502; message: string }

/**
 * Execute one tool call against a lane's already-resolved least-privilege list. Both proxies
 * are this function plus their own authorization: match the requested NAME to one of this
 * work item's tools (a supplied ref must be that tool's, never another's), then execute —
 * ourselves for a direct connection, through the broker otherwise.
 *
 * Shared on purpose. The run lane and the ask lane serve the same contexts, so a difference
 * in what a tool call may do would be a difference in what a context can reach depending on
 * how it was triggered — the thing bound connections exist to make impossible.
 */
export const callTool = async (opts: {
  meta: MetaStore
  broker: ToolBroker | null
  orgId: string
  encryptionKey: string | undefined
  allowed: RunTool[]
  subject: string
  tool: string
  args?: unknown
  ref?: string
  /** The same SHARED ref router the allowed set was resolved with, when there is one. Routing
   *  has to happen on BOTH halves or the pair disagrees: an `mcp:` tool would be listed by the
   *  MCP broker and then executed by the plan's, which for the default LocalBroker means a stub
   *  echo — a wrong ANSWER rather than an error, the worst failure of the two. */
  route?: (ref: string) => ToolBroker
}): Promise<ToolCallOutcome> => {
  const { meta, broker, orgId, encryptionKey, allowed, tool, args, ref } = opts
  const match = allowed.find((t) => t.def.name === tool && (!ref || t.ref === ref))
  if (!match) return { ok: false, status: 403, message: `tool not allowed for ${opts.subject}` }
  try {
    if (isDirect(match.kind)) {
      if (!encryptionKey)
        return { ok: false, status: 502, message: "direct connections need an encryption key" }
      const cn = await meta.getConnection(match.connectionId)
      if (!cn || cn.org_id !== orgId) return { ok: false, status: 404, message: "not found" }
      return { ok: true, result: await executeHttpTool(meta, cn, tool, args ?? {}, encryptionKey) }
    }
    if (!broker) return { ok: false, status: 502, message: "no broker for this workspace" }
    const via = (opts.route ?? refRouter(broker))(match.ref)
    return { ok: true, result: await via.execute({ ref: match.ref, tool, args: args ?? {} }) }
  } catch (e) {
    return { ok: false, status: 502, message: e instanceof Error ? e.message : "tool failed" }
  }
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
  /** Dev/test opt-in to the echo stub. Omitted, a workspace with no plan gets a refusing
   *  broker rather than one that fabricates plausible answers. */
  allowEchoStub = false,
): Promise<ToolBroker> => {
  const plan = await meta.resolvePlan(orgId, ownerUserId, "broker")
  if (plan && encryptionKey) {
    return makeBroker({
      provider: plan.provider,
      key: decryptSecret(plan.secret_enc, encryptionKey),
    })
  }
  return makeBroker(null, allowEchoStub)
}
