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
  /** Artifacts the runner published for this answer (the promotion channel). */
  artifacts?: { short_id: string; title: string }[]
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

  /** Post an answer. `answers` names the asker message it addresses — if a
   *  follow-up landed mid-run, the server keeps the session open for re-serve
   *  instead of settling it over the unseen follow-up. */
  answer(
    sessionId: string,
    bodyMd: string,
    meta: AnswerMeta,
    state: "answered" | "escalated",
    answers: string | undefined,
  ): Promise<unknown> {
    return this.call(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body_md: bodyMd, meta, state, answers }),
    })
  }

  fail(sessionId: string): Promise<unknown> {
    return this.call(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "failed" }),
    })
  }

  /** Publish a model-produced visual as a link-visible artifact. Link (not
   *  private): the artifact is owned by the context OWNER (the agent publishes
   *  on the registrant's behalf), so a private one would be unreadable to the
   *  very asker it was made for. Only session participants ever see the URL. */
  async publishArtifact(title: string, html: string): Promise<{ short_id: string }> {
    const form = new FormData()
    form.set("file", new Blob([html], { type: "text/html" }), "chart.html")
    form.set("title", title)
    form.set("visibility", "link")
    const res = await fetch(`${this.server}/v1/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
    })
    if (!res.ok) throw new Error(`publish → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<{ short_id: string }>
  }
}
