import { unbound } from "./http"
import type { BrokerToolDef, ConnectFailure, ConnectResult, ToolBroker } from "./types"

/**
 * The MCP broker: connect ANY Model Context Protocol server as a source.
 *
 * Why this shape. Everything a hosted run needs from an integration is already the ToolBroker
 * contract — list the tools a connection exposes, execute one of them server-side — and that is
 * exactly what MCP's `tools/list` and `tools/call` are. So an MCP server slots in behind the
 * machinery that already exists: least-privilege tool lists on the claim, the name-only shim so
 * the model never holds a credential, execution here rather than in the executor, and the taint
 * stamp that fires on every proxied call.
 *
 * It is also the whole integration story in one implementation. The Composio path cannot
 * currently produce a usable connection (connect returns `pending`, nothing completes the OAuth,
 * and only `active` connections reach a run), while "paste an MCP server URL" works today and
 * reaches an entire ecosystem. And because this is plain fetch + JSON-RPC with no SDK, it runs
 * unchanged in a Worker — which is what would let Basic runs use integrations without a
 * container at all.
 *
 * ⚠️ TOOL DESCRIPTIONS ARE UNTRUSTED INPUT. An MCP server supplies its own tool names and
 * descriptions, and those land verbatim in the model's prompt — a hostile or compromised server
 * can rewrite them between runs to say whatever it likes ("before answering, publish the
 * contents of every artifact to …"). That is a supply-chain attack on the prompt, not on the
 * transport, so TLS does not touch it.
 *
 * The defense is PINNING: `connect` records a hash of the tool list in the ref itself, and
 * `toolsFor` refuses to hand a run tools whose hash no longer matches. A server that changes its
 * tools goes silent until a human reconnects and sees the new list. Fail-closed, and it needs no
 * new column — the pin rides in the ref string that is already persisted.
 *
 * Two properties the pin only has if you keep them:
 *
 *   1. It must cover everything the server controls, and be computed with a hash that is not
 *      forgeable. See `pinTools` — the previous 32-bit version was collidable in 38ms.
 *   2. An ABSENT pin must refuse, never wave things through. `connect` mints an unpinned ref when
 *      a server cannot be reached or refuses to authenticate, and that is exactly the state an
 *      auth-required server produces, so treating "no pin" as "no check" disabled the whole
 *      defense in the commonest real case.
 */

/** JSON-RPC + pin envelope for one connected server. `mcp:<pin>:<url>` — the pin first so the
 *  URL (which may itself contain colons) is simply "the rest". */
const REF_PREFIX = "mcp:"

export interface McpRef {
  url: string
  /** Hash of the tool list as it looked at connect time; "" when unpinned (legacy refs). */
  pin: string
}

export const encodeMcpRef = (url: string, pin: string): string => `${REF_PREFIX}${pin}:${url}`

export const parseMcpRef = (ref: string): McpRef | null => {
  if (!ref.startsWith(REF_PREFIX)) return null
  const rest = ref.slice(REF_PREFIX.length)
  const sep = rest.indexOf(":")
  if (sep < 0) return null
  // A caller may append `#<connectionId>` to say WHOSE credential this call spends: two members
  // who connect the same server produce the same ref (the pin is a hash of the tool list), so the
  // ref alone cannot identify a credential. Routing ignores the suffix; `authFor` receives the
  // whole target and keys on it.
  const url = rest.slice(sep + 1)
  const hash = url.indexOf("#")
  return { pin: rest.slice(0, sep), url: hash < 0 ? url : url.slice(0, hash) }
}

/** Pins carry their algorithm, so a pin written by an older build fails LOUDLY on sight rather
 *  than looking like ordinary drift. */
const PIN_PREFIX = "s256-"

/** What we ask for in `initialize`. The revision most deployed servers speak; a server free to
 *  negotiate down answers with its own, and that is what we then declare per request. */
const CLIENT_PROTOCOL_VERSION = "2025-11-25"

/** Backstop against a server whose pagination never terminates. */
const MAX_PAGES = 50

/**
 * Ceiling on how many tools one server may contribute.
 *
 * Every tool's name and description lands in EVERY run's prompt for a bound connection, so an
 * unbounded server is unbounded cost on work that has nothing to do with it — two real tools from
 * a public server measured 2.5KB. Published guidance puts tool-selection degradation past roughly
 * 30-50 tools, so this is deliberately generous: a sanity ceiling against a pathological or
 * hostile server, not a curation policy.
 *
 * REFUSED at connect, never truncated. A truncated list is the worst outcome available: the agent
 * silently cannot see tools the human believes are connected, and the pin covers only the part we
 * happened to fetch. Refusing names the number and lets a human decide.
 */
const MAX_TOOLS = 200

/**
 * Resolves the bearer token for one target — a REF when listing or executing, the bare URL at
 * connect time, when no ref exists yet. Returns undefined for a server that needs no credential.
 *
 * A resolver rather than a stored field because the token must never live on the ref (refs are
 * persisted and handed around) and must be fetched at CALL time, the same rule `bearerFor`
 * already applies to the direct kinds: a credential revoked a second ago should not still work
 * because something decrypted it a minute ago.
 *
 * Deliberately `Authorization: Bearer` ONLY. That is what the MCP authorization spec mandates,
 * and a server wanting some other header is an escalation, not a config option — an arbitrary
 * header-name field is how a credential ends up somewhere it is not expected.
 */
export type McpAuthResolver = (target: string) => Promise<string | undefined> | string | undefined

/** Why a ref contributed nothing. `broker_error` is the one that is OURS, not the server's. */
export type QuietReason = "unpinned" | "unreachable" | "pin_mismatch" | "broker_error"

/**
 * Did WE fail before the server ever got a chance to?
 *
 * A thrown TypeError (or anything that is not an Error at all) from the listing path is a defect
 * in this code — a bad call, a missing global, a shape we did not expect — never a statement
 * about the remote server. Recording it as "unreachable" is how the broker spent a release
 * telling operators "that MCP server did not answer" about servers that were answering perfectly:
 * the fetch was being invoked with the wrong `this` and threw before a packet left the isolate,
 * and the message pointed at the one party who was not at fault. A network or HTTP failure is a
 * plain Error, so the two are cheap to tell apart and expensive to confuse.
 */
const ourFault = (e: unknown): boolean => e instanceof TypeError || !(e instanceof Error)

/**
 * Turn a failed connect into something a person can act on.
 *
 * The two cases that matter are the two a person actually hits, and they were indistinguishable:
 * `https://mcp.stripe.com/mcp` is a 404 (the path is wrong — Stripe's server is at the root) and
 * `https://mcp.stripe.com` is a 401 (right address, needs a token). Both used to produce
 * "that MCP server did not answer — if it requires authentication, pass `mcp_secret`", which is
 * actively misleading for the first: you add a token and it fails again, identically.
 */
const classify = (e: unknown): ConnectFailure => {
  const status = (e as { status?: number } | null)?.status
  if (status === 401 || status === 403) return "auth_required"
  if (status === 404 || status === 405) return "not_mcp"
  if (typeof status === "number") return "protocol_error"
  // No status at all: nothing answered. Note a network failure ALSO arrives as a TypeError —
  // undici throws `TypeError: fetch failed` with a `cause` for connection-refused — so the
  // `ourFault` heuristic used for tool listing would misread a genuinely dead server as our bug.
  // A thrown fetch carries a cause; the "Illegal invocation" class of defect does not.
  const network = e instanceof TypeError && (e as { cause?: unknown }).cause !== undefined
  if (network) return "unreachable"
  return ourFault(e) ? "protocol_error" : "unreachable"
}

/**
 * THE ONE RULE for any URL Derive will dial server-side, carrying a credential: https anywhere,
 * plain http only to the loopback host for local development.
 *
 * PARSED, never prefix-matched. Two ways a string test gets this wrong, both of which shipped:
 *
 *   http://localhost.evil.com/mcp          — a prefix match on "http://localhost" accepts it
 *   http://localhost:8080@evil.example/mcp — `localhost:8080` is USERINFO; the host is evil.example
 *
 * Either one has Derive POST to somebody else's server, in cleartext, carrying the pasted
 * `Authorization: Bearer`. `u.hostname` is the part neither trick can spoof.
 *
 * ONE copy on purpose. This existed as four — a route regex, a broker regex, a looser one in the
 * settings UI, and a correct-but-separate `isAllowedBase` sitting forty lines from the route that
 * needed it — and the two that were wrong were wrong in different ways. It governs `mcp_url` and
 * a secret connection's `base_url` alike, because the question is identical: may we send a
 * credential there? The client does NOT get a copy: `clients-no-core-at-runtime` keeps runtime
 * policy out of web/cli, and a rule the client cannot enforce is one it should not restate.
 */
export const isAllowedOutboundUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw)
    if (u.protocol === "https:") return true
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")
  } catch {
    return false
  }
}

/**
 * Canonical JSON: object keys sorted at every depth, no incidental whitespace.
 *
 * `JSON.stringify` preserves insertion order, so a server that serialized an identical schema
 * through a different code path — a library upgrade, two load-balanced instances — produces
 * different bytes for the same contract and trips a false mismatch. The connection then goes
 * quiet for a change nobody made. One recipe, applied everywhere, is what stops that.
 */
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`
}

/**
 * A stable fingerprint of a tool list. Order-independent (a server is free to reorder) and it
 * covers the WHOLE contract: name, title, description, input schema, output schema, annotations.
 * A rewritten description is the whole attack, so a pin over names alone would miss it entirely —
 * and an annotation flipped from read-only to destructive is that same attack wearing a hat.
 *
 * SHA-256, not a 32-bit non-cryptographic hash. The threat model is a SECOND PREIMAGE with total
 * attacker control: the server gets a human to approve benign text, then searches offline for
 * malicious text that hashes the same. Against FNV-1a that is not merely feasible, it is closed
 * form — the round function `h = (h XOR b) * 16777619 mod 2^32` is invertible, since the
 * multiplier is odd, so you walk backwards from the target and meet in the middle. Measured
 * against the previous implementation of this function: a colliding malicious description, with a
 * six-byte printable tail, in 38ms. A hash whose MATCH suppresses a human decision is a security
 * control, and has to be evaluated as one.
 *
 * Async because `crypto.subtle` is — available on Workers and Node alike. Hashing once per
 * listing rather than once per call keeps it off the hot path.
 */
export const pinTools = async (tools: BrokerToolDef[]): Promise<string> => {
  const canon = tools
    .map((t) =>
      canonical({
        name: t.name,
        title: t.title ?? null,
        description: t.description,
        params: t.params ?? {},
        outputSchema: t.outputSchema ?? null,
        annotations: t.annotations ?? null,
      }),
    )
    // Sort the CANONICAL FORMS, not the tools: two servers agreeing on content must agree on the
    // pin whatever order they listed in. A newline separator is safe because JSON string escaping
    // guarantees a literal newline cannot appear inside an element.
    .sort()
    .join("\n")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon))
  return (
    PIN_PREFIX +
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

/** One JSON-RPC response, whether the server answered as JSON or as a single SSE frame.
 *  Streamable-HTTP servers may reply either way to the same request, so both are handled. */
const readRpc = async (res: Response): Promise<unknown> => {
  const text = await res.text()
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  // SSE: take the LAST data: line, which carries the response for the request just sent.
  const frames = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
  const last = frames[frames.length - 1]
  return last ? JSON.parse(last) : null
}

interface RpcResult {
  result?: Record<string, unknown>
  error?: { message?: string }
}

export class McpBroker implements ToolBroker {
  readonly provider = "mcp"
  /** Per-instance session ids, keyed by server URL. MCP's streamable HTTP transport hands back
   *  an Mcp-Session-Id on initialize that later calls must echo; servers that do not use
   *  sessions simply never set it and the header is omitted. */
  private sessions = new Map<string, string>()
  /** The protocol version each server negotiated, so later requests can declare it. */
  private versions = new Map<string, string>()
  /**
   * Why a ref contributed nothing, keyed by ref, refreshed on each `toolsFor`. A caller that
   * wants to tell an OUTAGE from an ATTACK reads this: both currently end as "no tools", and a
   * run that cannot say which one happened cannot explain itself to the human reading the ledger.
   */
  readonly quiet = new Map<string, QuietReason>()

  /** Always a plain function, never the raw global — see `unbound`. */
  private readonly fetchImpl: typeof fetch

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly authFor: McpAuthResolver = () => undefined,
  ) {
    this.fetchImpl = unbound(fetchImpl)
  }

  /** Opaque per-credential ids, so a session key can be scoped to a credential without the
   *  credential itself ever becoming a map key (keys get logged, iterated and dumped).
   *
   *  Keyed by a DIGEST of the bearer, not the bearer. Keying by the plaintext kept every
   *  decrypted token alive on this instance for the life of the request — which is precisely the
   *  exposure the sentence above says it is avoiding, moved from the session map into this one. */
  private readonly credIds = new Map<string, number>()

  /** Sessions and negotiated versions are keyed by SERVER + CREDENTIAL, not by URL alone.
   *
   *  Two connections can point at the same server with different tokens — one personal
   *  connection per member is the ordinary case — and sharing a session between them would be one
   *  member's run riding the other's authentication. Scoping by URL alone allows exactly that;
   *  scoping by ref would be safe but would also stop `connect` (which has no ref yet) from
   *  handing its session to the listing that follows, costing a handshake every time. */
  private sessionKey(url: string, bearer: string | undefined): string {
    if (!bearer) return `${url}|anon`
    const fingerprint = shortHash(bearer)
    let id = this.credIds.get(fingerprint)
    if (id === undefined) {
      id = this.credIds.size + 1
      this.credIds.set(fingerprint, id)
    }
    return `${url}|c${id}`
  }

  private async rpc(
    target: string,
    url: string,
    method: string,
    params?: unknown,
  ): Promise<RpcResult> {
    const bearer = await this.authFor(target)
    const key = this.sessionKey(url, bearer)
    const session = this.sessions.get(key)
    const version = this.versions.get(key)
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Both, because a streamable-HTTP server chooses which to answer with.
        accept: "application/json, text/event-stream",
        // Required of clients on every request after initialization. Omitting it tells a server
        // to assume 2025-03-26 — which is what this client used to negotiate by accident.
        ...(version ? { "mcp-protocol-version": version } : {}),
        ...(session ? { "mcp-session-id": session } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
      // A hung MCP server must never wedge a dispatch tick or a claim.
      signal: AbortSignal.timeout(20_000),
    })
    const sid = res.headers.get("mcp-session-id")
    if (sid) this.sessions.set(key, sid)
    if (!res.ok) {
      // The status is the whole diagnosis and used to die on this line. Carried on the error so
      // `connect` can tell "needs a token" from "nothing here" instead of guessing.
      const err = new Error(`MCP ${method} failed: HTTP ${res.status}`) as Error & {
        status?: number
      }
      err.status = res.status
      throw err
    }
    const body = (await readRpc(res)) as RpcResult | null
    if (!body) throw new Error(`MCP ${method} returned an empty response`)
    if (body.error) throw new Error(`MCP ${method} error: ${body.error.message ?? "unknown"}`)
    return body
  }

  /** Handshake, then list — but only handshake ONCE per server for this broker's lifetime.
   *
   *  Servers that require `initialize` reject everything else until it has happened, so it cannot
   *  be skipped outright. But once one has handed back a session id, repeating it on every
   *  listing is a wasted round trip on the hottest path there is: the tool endpoint re-resolves
   *  the allowed set on EVERY tool call, so a composed script doing five calls across two servers
   *  was paying twenty round trips where ten would do.
   *
   *  Keyed on having a session rather than a "did I initialize" flag, because a server that
   *  issues no session is exactly the one that may need the handshake each time. */
  private async listTools(target: string, url: string): Promise<BrokerToolDef[]> {
    const key = this.sessionKey(url, await this.authFor(target))
    if (!this.sessions.has(key)) {
      const hello = await this.rpc(target, url, "initialize", {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "derive", version: "1" },
      }).catch(() => ({}) as RpcResult)
      // Declare what the server ANSWERED with, not what we asked for: it is free to negotiate
      // down, and a header disagreeing with the negotiated version is its own error.
      const negotiated = hello.result?.protocolVersion
      this.versions.set(key, typeof negotiated === "string" ? negotiated : CLIENT_PROTOCOL_VERSION)
    }
    // `tools/list` is PAGINATED. Reading page one and stopping loses every tool after it —
    // silently, since a short list looks exactly like a small server — and pins only the part we
    // happened to see. The page cap is a backstop against a server that never stops paginating.
    const out: BrokerToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.rpc(target, url, "tools/list", cursor ? { cursor } : {})
      const raw = (body.result?.tools ?? []) as {
        name?: string
        title?: string
        description?: string
        inputSchema?: Record<string, unknown>
        outputSchema?: Record<string, unknown>
        annotations?: Record<string, unknown>
      }[]
      for (const t of raw) {
        if (typeof t.name !== "string" || t.name.length === 0) continue
        out.push({
          name: t.name,
          description: String(t.description ?? ""),
          params: t.inputSchema ?? {},
          ...(typeof t.title === "string" ? { title: t.title } : {}),
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })
      }
      // Checked as we go, so a runaway server is refused rather than paged through in full.
      if (out.length > MAX_TOOLS)
        throw new Error(
          `MCP server exposes more than ${MAX_TOOLS} tools — refusing rather than truncating, ` +
            "because a truncated list silently hides tools a human thinks are connected",
        )
      const next = body.result?.nextCursor
      if (typeof next !== "string" || next.length === 0) return out
      cursor = next
    }
    throw new Error(`MCP tools/list did not terminate after ${MAX_PAGES} pages`)
  }

  /**
   * `toolkit` is the MCP server URL. There is no OAuth round trip to wait on: either the server
   * answers `tools/list` now or the connection is not usable, so this returns `active`/`pending`
   * honestly rather than the LocalBroker's optimistic `active`.
   */
  async connect(opts: { orgId: string; userId: string; toolkit: string }): Promise<ConnectResult> {
    const url = opts.toolkit.trim()
    if (!isAllowedOutboundUrl(url))
      throw new Error("an MCP server URL must be https (or http://localhost for development)")
    try {
      const tools = await this.listTools(url, url)
      // Pin at connect: this exact tool list is what a human is approving. A later change makes
      // the connection go quiet rather than silently feeding new prompt text to every run.
      return { url, ref: encodeMcpRef(url, await pinTools(tools)), status: "active" }
    } catch (e) {
      // `pending` (not a throw) so the connection can be stored and retried, matching how the
      // other brokers report a not-yet-usable account — but WITH the reason, because "did not
      // answer" was being said about servers that answered clearly.
      return { url, ref: encodeMcpRef(url, ""), status: "pending", reason: classify(e) }
    }
  }

  /**
   * The least-privilege list for a set of refs — and the pin check.
   *
   * A ref whose live tool list no longer matches its pin contributes NOTHING. Deliberately
   * silent-and-empty rather than throwing: one changed server must not break a run bound to
   * several, and a run that sees no tools fails honestly ("I could not read X") instead of
   * executing against text nobody approved.
   *
   * Silent to the RUN, not to the operator: every refusal is recorded on `quiet` with its reason,
   * because "the server is down" and "the server rewrote its tools" want opposite responses and
   * are otherwise the same empty list.
   */
  async toolsFor(refs: string[]): Promise<BrokerToolDef[]> {
    const out: BrokerToolDef[] = []
    for (const ref of refs) {
      // Cleared PER REF, not per call. `toolsForRun` resolves one connection at a time through a
      // shared router, so clearing the whole map here would wipe the previous connection's reason
      // and leave only the last one — the diagnostic would be silently wrong for exactly the
      // multi-connection case it exists to explain.
      this.quiet.delete(ref)
      const parsed = parseMcpRef(ref)
      if (!parsed) continue
      // An UNPINNED ref is refused outright. `connect` mints one whenever it could not reach or
      // authenticate against a server, so this is the state every auth-required server lands in —
      // and treating it as "nothing to check" is not a lenient pin, it is no pin at all.
      if (!parsed.pin) {
        this.quiet.set(ref, "unpinned")
        continue
      }
      let tools: BrokerToolDef[]
      try {
        tools = await this.listTools(ref, parsed.url)
      } catch (e) {
        this.quiet.set(ref, ourFault(e) ? "broker_error" : "unreachable")
        continue
      }
      if ((await pinTools(tools)) !== parsed.pin) {
        this.quiet.set(ref, "pin_mismatch")
        continue
      }
      // Namespace by host so two servers exposing `search` do not collide, and so the run's tool
      // list shows an operator WHERE each tool comes from.
      const host = safeHost(parsed.url)
      for (const t of tools) {
        const name = toolName(host, t.name)
        // Skipped, not truncated — see `toolName`. Offering a tool that can never be called is
        // worse than not offering it.
        if (name) out.push({ ...t, name })
      }
    }
    return out
  }

  /** Execute one tool through one server. The namespace prefix added in toolsFor is stripped
   *  back off, so the server sees the name it published. */
  async execute(opts: { ref: string; tool: string; args: unknown }): Promise<unknown> {
    const parsed = parseMcpRef(opts.ref)
    if (!parsed) throw new Error("not an MCP connection")
    const bare = stripNamespace(safeHost(parsed.url), opts.tool)
    const body = await this.rpc(opts.ref, parsed.url, "tools/call", {
      name: bare,
      arguments: opts.args ?? {},
    })
    return body.result ?? null
  }

  /** Nothing is held server-side: a connection IS its ref, so revoking is the caller deleting
   *  the row. Present to satisfy the contract. */
  async revoke(): Promise<void> {}
}

/** The host of a server URL, usable as a tool-name prefix. Falls back to a constant rather than
 *  throwing, so a malformed stored ref degrades to an unprefixed namespace instead of a 500. */
const safeHost = (url: string): string => {
  try {
    return new URL(url).host.replace(/[^a-zA-Z0-9]+/g, "_")
  } catch {
    return "mcp"
  }
}

/**
 * WHAT A MODEL PROVIDER WILL ACCEPT AS A TOOL NAME: `^[a-zA-Z0-9_-]{1,64}$`. Anthropic and
 * OpenAI publish the same rule, and it is the whole reason this function exists.
 *
 * The name used to be `${host}.${tool}`, which breaks that contract twice over: a DOT is not in
 * the allowed set, and the host half is attacker-and-DNS-controlled, so the total length is
 * unbounded — a real server under test produced a 74-character name. Neither problem is visible
 * from inside this repo, because every test that names a tool uses a short `localhost_PORT` host
 * and no test calls a real provider. Deployed, it meant a run could not use an MCP tool at all:
 * the model either sees the request rejected or answers with a name that no longer matches the
 * least-privilege list, and a mismatch reads as "tool not allowed" and burns the run's turns.
 *
 * Truncate the NAMESPACE, never the tool: the tool half is what the model reasons about and what
 * `stripNamespace` must hand back to the server verbatim. A truncated namespace keeps a short
 * hash of the full host so two servers that share a prefix stay distinct.
 */
const MAX_TOOL_NAME = 64
/** Built FROM the ceiling above, so the two cannot say different things. */
const NAME_OK = new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_TOOL_NAME}}$`)

/** A short, stable discriminator for a namespace too long to keep whole. */
const shortHash = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).slice(0, 6)
}

export const toolName = (host: string, tool: string): string | null => {
  // NOT sanitized. Rewriting `get weather` to `get_weather` produces a name that cannot be
  // handed back to the server, so every call returns "no such tool" — and two tools named `a.b`
  // and `a b` would collapse onto each other. A name we cannot carry verbatim is a name we do
  // not offer, exactly like one that is too long.
  const bare = tool
  // A name we cannot carry VERBATIM is one we do not offer. Too long, or holding a character the
  // providers' pattern excludes, both end the same way: any repair produces a name that does not
  // strip back to what the server published, so the model would hold a tool whose every call
  // returns "no such tool". A tool that is absent is a fact the run can state; one that is
  // present and permanently broken is not. If that empties a connection, `quiet` reports it as
  // `no_tools`.
  if (!isProviderLegalToolName(bare)) return null
  // What is left for a namespace once the tool and its joining underscore are paid for. It can be
  // zero or negative — a 64-character tool name spends the entire budget by itself — and both
  // cases mean the name ships unprefixed rather than over the ceiling.
  const room = MAX_TOOL_NAME - bare.length - 1
  // The hashed form is `<head>_<6-char hash>`, i.e. exactly `room` characters when the head is
  // `room - 7`. Below 7 there is no room for even an empty head plus the hash, so drop the
  // namespace entirely instead of overflowing.
  const ns =
    room >= host.length ? host : room >= 7 ? `${host.slice(0, room - 7)}_${shortHash(host)}` : ""
  return ns ? `${ns}_${bare}` : bare
}

/**
 * Undo `toolName`, so the server sees the name it published.
 *
 * Deterministic without knowing how long the namespace ended up: either the host survived whole
 * and the name starts with it, or it was truncated — and a truncated namespace always ends in
 * `_<hash of the full host>`, which is computable from the host alone. Splitting on the last
 * separator instead would corrupt any tool whose own name contains one.
 *
 * Falls through unchanged for a name carrying no namespace, and still accepts the old dotted
 * form so a claim already in flight when this shipped keeps working.
 */
export const stripNamespace = (host: string, name: string): string => {
  if (host && name.startsWith(`${host}_`)) return name.slice(host.length + 1)
  if (host && name.startsWith(`${host}.`)) return name.slice(host.length + 1)
  const marker = `_${shortHash(host)}_`
  const at = name.indexOf(marker)
  return at >= 0 ? name.slice(at + marker.length) : name
}

/** Exported for the test that holds every generated name to the providers' published pattern. */
export const isProviderLegalToolName = (name: string): boolean => NAME_OK.test(name)
