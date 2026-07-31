import { unbound } from "./http"
import type { BrokerToolDef, ConnectResult, ToolBroker } from "./types"

const API_BASE = "https://backend.composio.dev/api/v3"

/**
 * ComposioBroker — the production ToolBroker over Composio's hosted gateway (per-user OAuth
 * across 1,000+ toolkits). Metered on the OWNER's own Composio key (from their broker plan),
 * never a platform key. Config-gated: constructed only when a composio broker plan is present,
 * so tests and local self-hosts never reach it. The endpoint shapes below follow Composio's v3
 * API and are the integration contract to verify against a live key before shipping to real
 * users; nothing else in Derive imports the vendor, so it stays swappable.
 */
export class ComposioBroker implements ToolBroker {
  readonly provider = "composio"

  /** Always a plain function, never the raw global — see `unbound`. */
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly apiKey: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = unbound(fetchImpl)
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(`composio ${path} → ${res.status}`)
    return res.json()
  }

  async connect(opts: { orgId: string; userId: string; toolkit: string }): Promise<ConnectResult> {
    // A connected-account link for this user_id + toolkit. Composio returns a hosted redirect;
    // the account is pending until the user authorizes (a Composio webhook flips it active,
    // handled by the connections callback route).
    const body = JSON.stringify({ user_id: opts.userId, toolkit: opts.toolkit })
    const out = (await this.call("/connected_accounts/link", { method: "POST", body })) as {
      redirect_url?: string
      id?: string
    }
    return { url: out.redirect_url ?? "", ref: out.id ?? "", status: "pending" }
  }

  async toolsFor(refs: string[]): Promise<BrokerToolDef[]> {
    if (refs.length === 0) return []
    const q = new URLSearchParams({ connected_account_ids: refs.join(",") })
    const out = (await this.call(`/tools?${q.toString()}`)) as {
      items?: { name: string; description?: string; parameters?: Record<string, unknown> }[]
    }
    return (out.items ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      params: t.parameters ?? {},
    }))
  }

  async execute(opts: { ref: string; tool: string; args: unknown }): Promise<unknown> {
    const body = JSON.stringify({ connected_account_id: opts.ref, arguments: opts.args })
    return this.call(`/tools/${encodeURIComponent(opts.tool)}/execute`, { method: "POST", body })
  }

  async revoke(ref: string): Promise<void> {
    await this.call(`/connected_accounts/${encodeURIComponent(ref)}`, { method: "DELETE" })
  }
}
