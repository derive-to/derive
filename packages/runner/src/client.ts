// The runner's Derive client: four calls, plain fetch, the agent bearer on each.

export interface QueueMessage {
  id: string
  author_kind: "asker" | "agent"
  author_id: string
  body_md: string
  meta: unknown
  created_at: string
}

export interface QueueSession {
  id: string
  state: string
  context_version: number
  messages: QueueMessage[]
}

export interface ContextInfo {
  id: string
  name: string
  manifest_short_id: string | null
  manifest_version?: number
  /** The manifest's current source — the runner's system prompt. */
  manifest_md?: string | null
}

export interface AnswerMeta {
  query?: string | null
  confidence?: number | null
  caveats?: string[]
  escalation_reason?: string | null
}

export class DeriveClient {
  constructor(
    private server: string,
    private token: string,
  ) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.server}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    })
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  getContext(contextId: string): Promise<ContextInfo> {
    return this.call(`/v1/contexts/${contextId}`)
  }

  async queue(contextId: string, limit = 10): Promise<QueueSession[]> {
    const r = await this.call<{ sessions: QueueSession[] }>(
      `/v1/contexts/${contextId}/queue?limit=${limit}`,
    )
    return r.sessions
  }

  answer(
    sessionId: string,
    bodyMd: string,
    meta: AnswerMeta,
    state: "answered" | "escalated" = "answered",
  ): Promise<unknown> {
    return this.call(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body_md: bodyMd, meta, state }),
    })
  }

  fail(sessionId: string): Promise<unknown> {
    return this.call(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "failed" }),
    })
  }
}
