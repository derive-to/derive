import type { BrokerToolDef, ToolBroker } from "@derive/broker"
import { type McpAuthResolver, makeBroker, quietReason, refRouter } from "@derive/broker"
import type { ConnectionKind, ConnectionRecord, MetaStore } from "@derive/core"
import { decryptSecret } from "./crypto"
import { installationToken } from "./github-app"
import { liveBearer } from "./mcp-oauth"

/** One tool a hosted run may call, paired with the connected-account ref it executes through.
 *  `kind` and `connectionId` are how the tool proxy routes the call without a second lookup;
 *  the connection RECORD is deliberately not here — it carries secret_enc, and this struct
 *  flows toward the claim response, which is the last stop before the wire.
 *
 *  That rule still holds, but its REASON has narrowed: keeping a credential out of the
 *  executor is no longer the product's safety story (a run with a machine is given the real
 *  keys its context was bound to, and writes ordinary code with them — see the "keys to the
 *  run" decision). What this struct protects is narrower and still worth protecting: a claim
 *  must hand over exactly the access the work item was granted and no routing detail beyond
 *  it, so a bug here can't widen one run's reach into another's. */

/** One bound connection that contributed nothing, and why — the difference between an outage
 *  and a server that rewrote its tools after someone approved them. */
export interface SourceQuiet {
  connection_id: string
  toolkit: string
  /** unpinned | unreachable | pin_mismatch from the MCP broker; `no_tools` when the broker
   *  offers no explanation (a plan broker with nothing connected, say). */
  reason: string
  /** The same thing in a sentence, resolved HERE so no executor has to keep its own copy.
   *
   *  Both lanes render this to a model and, on a failure, to the ledger a person reads. The
   *  wording lived in two places — apps/api's loop and packages/cli's runner — kept in step by a
   *  comment saying they matched, which is not a mechanism. The CLI is deliberately
   *  dependency-free (it cannot import @derive/core; `decideWrite` is ported into it for the same
   *  reason), so a shared module was never available to them. Sending the sentence with the
   *  reason costs nothing and leaves exactly one copy, here, next to the code that decides it. */
  why: string
}

/** Why a bound source contributed nothing, in words a person and a model both read. Keyed by the
 *  machine reason so an unknown one still degrades to something legible rather than blank. */
const QUIET_WHY: Record<string, string> = {
  unreachable: "the server could not be reached",
  pin_mismatch:
    "the server's tool descriptions CHANGED since a human approved them, so it is being " +
    "ignored until someone re-approves it",
  unpinned: "the connection was never successfully approved",
  no_tools: "it exposed no tools",
  // Not the server's fault, and the wording must not imply it is. This is the case that spent a
  // release blaming healthy servers for a bug on our side.
  broker_error:
    "Derive failed before it could ask the server — this is a fault on our side, not the " +
    "server's, and it needs a bug report rather than a reconnect",
}
export const quietWhy = (reason: string): string => QUIET_WHY[reason] ?? reason

export interface RunTool {
  def: BrokerToolDef
  ref: string
  kind: ConnectionKind
  connectionId: string
}

/**
 * The connections a work item may actually SPEND: its bound ids, narrowed to the ones in THIS
 * org that are active, and — for a personal connection, which acts as its owner — whose owner
 * is still a member. An offboarded member's credential stops resolving on the very next run,
 * the same live-membership recheck a minted API token gets at spend time; workspace
 * connections are the org's and survive.
 *
 * Separate from `toolsForRun` on purpose. "Can this run spend a credential?" and "what HTTP
 * tools does it get?" are DIFFERENT questions, and conflating them fails open: a connection
 * with no base_url yields no tools (see below) yet is still a real credential the run may be
 * handed. The write gate's `credentialed` rung must count THESE, never the tool list.
 */
export const spendableConnections = async (
  meta: MetaStore,
  orgId: string,
  connectionIds: string[],
): Promise<ConnectionRecord[]> => {
  if (connectionIds.length === 0) return []
  const conns = await meta.getConnectionsByIds(connectionIds)
  const active = conns.filter((cn) => cn.org_id === orgId && cn.status === "active")
  const owners = [...new Set(active.filter((cn) => cn.scope === "personal").map((c) => c.user_id))]
  const seats = await Promise.all(
    owners.map(async (uid) => [uid, await meta.getMembership(orgId, uid)] as const),
  )
  const stillMembers = new Set(seats.filter(([, seat]) => seat !== null).map(([uid]) => uid))
  return active.filter((cn) => cn.scope === "workspace" || stillMembers.has(cn.user_id))
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
  /** Filled with one entry per connection that contributed NOTHING, and why. An out-param
   *  rather than a wider return type so every existing caller is untouched — but a caller that
   *  wants to explain itself ("I could not read X") now can, instead of a run silently missing
   *  a source and nobody knowing whether the server is down or its tools were rewritten. */
  quiet?: SourceQuiet[],
): Promise<RunTool[]> => {
  const spendable = await spendableConnections(meta, orgId, connectionIds)
  // A direct connection is called by resolving a path against its base_url and refusing
  // anything that escapes it, so one without a base_url has nothing to call: base_url is
  // optional now (nobody types a host — such a connection is spent by DELIVERY into a run
  // that writes its own code), and advertising `x.get`/`x.post` for it would hand the model
  // two tools that throw on every call. Expose none instead — but note it is still SPENDABLE,
  // which is why the gate counts spendableConnections and not this list.
  const usable = spendable.filter((cn) => !isDirect(cn.kind) || !!cn.base_url)
  // Per-CONNECTION routing through ONE router: an `mcp:` ref reaches the MCP broker whatever the
  // workspace's broker plan is (it needs no vendor account at all), everything else keeps the
  // plan's broker. Sharing the router across this resolution is what lets the MCP client reuse
  // its session instead of re-handshaking per connection, and carries the per-ref bearer.
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
    let defs: BrokerToolDef[]
    if (isDirect(cn.kind)) defs = httpTools(cn.toolkit)
    else {
      const via = route(cn.broker_ref)
      // Addressed by ref AND connection: the ref routes, the id says whose credential.
      const target = authTarget(cn.broker_ref, cn.id)
      defs = await via.toolsFor([target]).catch(() => [])
      if (defs.length === 0) {
        const reason = quietReason(via, target) ?? "no_tools"
        quiet?.push({ connection_id: cn.id, toolkit: cn.toolkit, reason, why: quietWhy(reason) })
      }
    }
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
  // Keyed by CONNECTION ID, which the caller appends to the target as `<ref>#<id>`.
  //
  // Resolving by ref alone is not merely imprecise, it is a cross-user credential leak: a ref is
  // `mcp:<pin>:<url>` and the pin is a hash of the tool list, so two members who connect the SAME
  // server produce the SAME ref. "The row with this ref that has a secret" then hands one
  // member's run whatever token the other stored — the exact fallback that "identity never falls
  // back" forbids. A connection id cannot collide, and the org check keeps a guessed id from
  // reaching another tenant's row.
  const cache = new Map<string, Promise<ConnectionRecord | null>>()
  return async (target: string) => {
    if (!encryptionKey) return undefined
    const hash = target.indexOf("#")
    if (hash < 0) return undefined
    const id = target.slice(hash + 1)
    let row = cache.get(id)
    if (!row) {
      row = meta.getConnection(id)
      cache.set(id, row)
    }
    const cn = await row
    if (!cn || cn.org_id !== orgId || !cn.secret_enc) return undefined
    // One call site for BOTH credential shapes. A pasted key comes back as itself; an OAuth blob
    // is refreshed here if it is about to expire, which is why this resolver runs per call rather
    // than per request. An unreadable credential returns undefined — never the raw blob, which
    // would put our ciphertext on somebody else's server. See lib/mcp-oauth.ts.
    return await liveBearer(meta, cn, encryptionKey)
  }
}

/** The target string an MCP call is resolved against: the ref (routing) plus the connection id
 *  (whose credential). Two members on one server share a ref and must not share a token. */
export const authTarget = (ref: string, connectionId: string): string => `${ref}#${connectionId}`

/** The tools a direct connection exposes. Named `<toolkit>.<verb>` to match the broker's
 *  convention, so the runner's shim treats every kind of connection identically.
 *
 *  FROZEN SURFACE — do not grow this. Its only remaining consumer is the MACHINELESS lane:
 *  the in-process Workers loop (lib/substrate-loop.ts, the run and session `toolProxy` call
 *  sites), which has no container and therefore cannot run code. Everywhere a machine exists,
 *  a context's credentials are DELIVERED to the run and the agent uses ordinary libraries —
 *  which is both more capable and less for us to maintain.
 *
 *  So: a new credential shape (a database URL, an MCP server, a webhook, a key that rides a
 *  custom header) must NOT arrive here as another tool kind or another verb. That road ends in
 *  a zoo of hand-written connectors, each a dialect no model was trained on, replacing the
 *  interface models are already best at. Add it to delivery instead. */
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
 * Serves the machineless lane only (see httpTools' FROZEN SURFACE note). The confinement
 * below is genuinely load-bearing THERE — it is the only boundary that lane has — which is
 * why the checks stay exactly as strict as when they were written.
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
  // 409 is the AMBIGUOUS case: the name matched more than one bound source, which is a conflict
  // to resolve rather than a permission to deny.
  | { ok: false; status: 403 | 404 | 409 | 502; message: string }

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
  const matches = allowed.filter((t) => t.def.name === tool && (!ref || t.ref === ref))
  const match = matches[0]
  if (!match) return { ok: false, status: 403, message: `tool not allowed for ${opts.subject}` }
  // AMBIGUOUS NAMES MUST NOT RESOLVE TO WHICHEVER CAME FIRST. A tool's name carries a namespace
  // derived from its server's host, and `safeHost` folds every non-alphanumeric run to `_`, so
  // `sub.example.com` and `sub-example.com` — two unrelated registrable domains — produce the
  // same prefix. Taking the first match would run one server's tool against ANOTHER server's ref
  // and credential, sending the caller's arguments somewhere they were never meant to go. There
  // is no safe way to guess which was meant, so refuse and say so.
  if (matches.length > 1)
    return {
      ok: false,
      status: 409,
      message: `"${tool}" is ambiguous for ${opts.subject}: ${matches.length} bound sources expose that name. Disconnect one, or pass \`ref\` to name the source.`,
    }
  try {
    if (isDirect(match.kind)) {
      if (!encryptionKey)
        return { ok: false, status: 502, message: "direct connections need an encryption key" }
      const cn = await meta.getConnection(match.connectionId)
      if (!cn || cn.org_id !== orgId) return { ok: false, status: 404, message: "not found" }
      return { ok: true, result: await executeHttpTool(meta, cn, tool, args ?? {}, encryptionKey) }
    }
    if (!broker) return { ok: false, status: 502, message: "no broker for this workspace" }
    // Execute must spend the SAME connection's credential the listing used, so it addresses by
    // (ref, connection) too. A shared router built without this run's connections resolves no
    // credential, which fails closed — an unauthenticated call the server refuses — rather than
    // silently reaching for whichever token happens to match the ref.
    const via = (opts.route ?? refRouter(broker, mcpAuthFor(meta, orgId, encryptionKey)))(match.ref)
    return {
      ok: true,
      result: await via.execute({
        ref: authTarget(match.ref, match.connectionId),
        tool,
        args: args ?? {},
      }),
    }
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
