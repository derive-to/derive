import type { BrokerToolDef, ConnectResult, ToolBroker } from "./types"

/**
 * The broker a workspace gets when it has no real one: it refuses, loudly, instead of pretending.
 *
 * The alternative — and what shipped before this — was the LocalBroker, whose `execute` returns
 * the CALLER'S OWN ARGUMENTS. That is exactly right as a fixture and catastrophic as a default:
 * a production run "successfully" calls Stripe, gets its own arguments back, reports success, and
 * writes an artifact built on data that never existed. Nothing errors. Nothing looks wrong. The
 * only signal is that the numbers are made up.
 *
 * So the echo broker is now opt-in (`DERIVE_LOCAL_BROKER`), and everything else lands here. A
 * refusal is recoverable — someone reads the message and connects a source. A convincing lie is
 * not, because by the time anyone notices, it is in a published artifact.
 *
 * MCP connections never reach this class: they route on their own ref and carry their own server,
 * so a workspace with no broker plan at all can still connect one. That is the intended path.
 */
export class RefusingBroker implements ToolBroker {
  readonly provider = "none"

  private refuse(): never {
    throw new Error(
      "no integration broker is configured for this workspace — connect an MCP server, " +
        "paste a secret connection, or attach a Composio broker plan " +
        "(developers: set DERIVE_LOCAL_BROKER=1 for the echo stub)",
    )
  }

  async connect(): Promise<ConnectResult> {
    this.refuse()
  }

  /** Empty rather than a throw, matching how every other unusable connection behaves: one
   *  misconfigured source must not take down a run bound to several. The run then reports a
   *  missing tool, which is true, instead of calling an echo and believing the answer. */
  async toolsFor(): Promise<BrokerToolDef[]> {
    return []
  }

  async execute(): Promise<unknown> {
    this.refuse()
  }

  async revoke(): Promise<void> {}
}
