// The tool broker — Derive's OWN interface over an external "auth + tools for agents"
// provider (Composio first). It is the seam that keeps the vendor swappable: nothing outside
// this package imports a provider SDK, and the BYO-runner path never touches it at all (a BYO
// runner brings its own tools and credentials). A broker gives a HOSTED run hands: per-user
// connected accounts, the least-privilege set of tools they expose, and tool execution.

/** A connected external account, keyed by a broker-side ref (the connected-account id). */
export interface BrokerConnection {
  /** Broker-side connected-account id. Stored on the Derive ConnectionRecord as broker_ref. */
  ref: string
  /** Toolkit slug, e.g. "gmail" | "stripe" | "github". */
  toolkit: string
  /** active once the user has authorized; pending while the OAuth round trip is open. */
  status: "active" | "pending"
}

/** One tool a connected account exposes. `params` is a loose JSON-schema-ish shape.
 *
 *  Everything below `params` is OPTIONAL because only the MCP broker carries it, and it exists
 *  for one reason: the pin has to cover the whole contract a server can change under us. A tool
 *  whose `annotations` flip from read-only to destructive is a different tool, and a pin that
 *  ignored them would call that "unchanged". */
export interface BrokerToolDef {
  name: string
  description: string
  params: Record<string, unknown>
  /** Display title. Server-supplied, so it is untrusted text like the description. */
  title?: string
  /** Structured output shape, when the server declares one. */
  outputSchema?: Record<string, unknown>
  /** Behavioural hints (readOnlyHint, destructiveHint, …). UNVERIFIED server self-description:
   *  they may inform UX and caching, never authorization. Pinned so an escalation is visible. */
  annotations?: Record<string, unknown>
}

/** The result of starting a connection: where to authorize, the broker ref to persist, and
 *  whether it is already usable (the LocalBroker auto-authorizes for dev/test). */
export interface ConnectResult {
  url: string
  ref: string
  status: "active" | "pending"
}

export interface ToolBroker {
  /** Provider slug, e.g. "local" | "composio". */
  readonly provider: string
  /** Begin connecting a toolkit for a specific user (per-user isolation). */
  connect(opts: { orgId: string; userId: string; toolkit: string }): Promise<ConnectResult>
  /** The tools a set of connected-account refs expose — the LEAST-PRIVILEGE boundary. A run
   *  sees tools for its bound refs ONLY, never the workspace's whole connection list. */
  toolsFor(refs: string[]): Promise<BrokerToolDef[]>
  /** Execute one tool through one connected account. */
  execute(opts: { ref: string; tool: string; args: unknown }): Promise<unknown>
  /** Revoke a connected account. */
  revoke(ref: string): Promise<void>
}
