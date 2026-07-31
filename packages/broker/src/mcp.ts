import { unbound } from "./http"
import type { BrokerToolDef, ConnectResult, ToolBroker } from "./types"

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
  readonly quiet = new Map<string, "unpinned" | "unreachable" | "pin_mismatch">()

  /** Always a plain function, never the raw global — see `unbound`. */
  private readonly fetchImpl: typeof fetch

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly authFor: McpAuthResolver = () => undefined,
  ) {
    this.fetchImpl = unbound(fetchImpl)
  }

  /** Opaque per-credential ids, so a session key can be scoped to a credential without the
   *  credential itself ever becoming a map key (keys get logged, iterated and dumped). */
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
    let id = this.credIds.get(bearer)
    if (id === undefined) {
      id = this.credIds.size + 1
      this.credIds.set(bearer, id)
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
    if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status}`)
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
    if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost[:/]/i.test(url))
      throw new Error("an MCP server URL must be https (or http://localhost for development)")
    try {
      const tools = await this.listTools(url, url)
      // Pin at connect: this exact tool list is what a human is approving. A later change makes
      // the connection go quiet rather than silently feeding new prompt text to every run.
      return { url, ref: encodeMcpRef(url, await pinTools(tools)), status: "active" }
    } catch {
      // Unreachable or not speaking MCP. `pending` (not a throw) so the connection can be stored
      // and retried, matching how the other brokers report a not-yet-usable account.
      return { url, ref: encodeMcpRef(url, ""), status: "pending" }
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
      } catch {
        this.quiet.set(ref, "unreachable")
        continue
      }
      if ((await pinTools(tools)) !== parsed.pin) {
        this.quiet.set(ref, "pin_mismatch")
        continue
      }
      // Namespace by host so two servers exposing `search` do not collide, and so the run's tool
      // list shows an operator WHERE each tool comes from.
      const host = safeHost(parsed.url)
      for (const t of tools) out.push({ ...t, name: `${host}.${t.name}` })
    }
    return out
  }

  /** Execute one tool through one server. The namespace prefix added in toolsFor is stripped
   *  back off, so the server sees the name it published. */
  async execute(opts: { ref: string; tool: string; args: unknown }): Promise<unknown> {
    const parsed = parseMcpRef(opts.ref)
    if (!parsed) throw new Error("not an MCP connection")
    const host = safeHost(parsed.url)
    const bare = opts.tool.startsWith(`${host}.`) ? opts.tool.slice(host.length + 1) : opts.tool
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
