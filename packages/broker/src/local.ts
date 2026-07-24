import type { BrokerToolDef, ConnectResult, ToolBroker } from "./types"

// The LocalBroker: a deterministic, dependency-free broker for development, tests, and any
// self-host that hasn't configured a real provider. It holds no external credentials and
// talks to no network. `connect` auto-authorizes (status "active") so the whole hosted flow
// is exercisable end to end without a browser or a vendor account; `toolsFor` returns a fixed
// read/write pair per toolkit; `execute` echoes a deterministic result. It is the reference
// implementation of the ToolBroker contract — swapping in ComposioBroker changes nothing above.

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
