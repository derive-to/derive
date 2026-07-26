import type { BrokerToolDef, ConnectResult, ToolBroker } from "./types"

// The LocalBroker: a deterministic, dependency-free broker for development, tests, and any
// self-host that hasn't configured a real provider. It holds no external credentials and
// talks to no network. `connect` auto-authorizes (status "active") so the whole hosted flow
// is exercisable end to end without a browser or a vendor account; `toolsFor` returns a fixed
// read/write pair per toolkit; `execute` echoes a deterministic result. It is the reference
// implementation of the ToolBroker contract — swapping in ComposioBroker changes nothing above.
//
// ⚠️ IT IS A STUB, AND IT IS THE DEFAULT. `execute` returns the caller's own arguments; it
// does not reach Gmail, or Stripe, or anything. That is right for a fixture and wrong for a
// user, so it must never sit behind a "Connect your account" button — which is why the Sources
// settings screen was removed rather than shipped. A `local://` connection reporting `active`
// means "the plumbing works", not "your account is connected".
//
// The real broker cannot currently produce a usable connection either: ComposioBroker.connect
// returns `pending` with an OAuth redirect, nothing completes it (routes/connections.ts has no
// callback), and toolsForRun passes only `active` connections to a run. So the missing piece
// before any of this is user-facing is the OAuth completion route, plus verifying Composio's
// v3 shapes against a live key. Everything either side of that — least-privilege tool lists on
// the claim, the name-only shim, server-side execution so no credential reaches the model — is
// built and proven.

/** A stable ref for a (user, toolkit) so repeated connects are idempotent and least-privilege
 *  scoping is testable. */
const localRef = (userId: string, toolkit: string): string => `local:${toolkit}:${userId}`

/** The tools a toolkit exposes in the local broker: a read and a write, scoped to the ref. */
const localTools = (toolkit: string): BrokerToolDef[] => [
  {
    name: `${toolkit}.read`,
    description: `Read data from ${toolkit} (local broker).`,
    params: { query: { type: "string" } },
  },
  {
    name: `${toolkit}.write`,
    description: `Write data to ${toolkit} (local broker).`,
    params: { input: { type: "object" } },
  },
]

/** Which toolkit a local ref belongs to (ref shape is local:<toolkit>:<userId>). */
const toolkitOf = (ref: string): string => ref.split(":")[1] ?? "unknown"

export class LocalBroker implements ToolBroker {
  readonly provider = "local"

  async connect(opts: { orgId: string; userId: string; toolkit: string }): Promise<ConnectResult> {
    const ref = localRef(opts.userId, opts.toolkit)
    // Auto-authorized: no OAuth round trip in the local broker.
    return { url: `local://connected/${ref}`, ref, status: "active" }
  }

  async toolsFor(refs: string[]): Promise<BrokerToolDef[]> {
    // Least privilege: only the tools of the passed refs, deduped by toolkit.
    const toolkits = [...new Set(refs.map(toolkitOf))]
    return toolkits.flatMap(localTools)
  }

  async execute(opts: { ref: string; tool: string; args: unknown }): Promise<unknown> {
    return { ok: true, provider: "local", ref: opts.ref, tool: opts.tool, args: opts.args }
  }

  async revoke(_ref: string): Promise<void> {
    // Nothing external to revoke in the local broker.
  }
}
