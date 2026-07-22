// The hosted agent's window onto Derive: every call is bearer-authed as ONE
// hosted agent (its registered token), so the server resolves the agent's
// principal, its on-behalf-of human, and its role cap exactly as it does for the
// runner. The harness never reaches past this surface — it is the public REST
// API, the same contract any agent gets. Mirrors the runner's DeriveClient shape
// (packages/cli) so the two lanes speak one protocol.

export interface RevisionInput {
  /** The full new source of the artifact. */
  content: string
  /** index.html / notes.md — sets the stored content type. */
  filename: string
  /** The version message. */
  message?: string
  /** Thread ids this revision addresses (resolved on publish / on approval). */
  addresses?: string[]
}

export interface PublishResult {
  short_id: string
  version: number
}

/** The tool surface, as a plain interface so the safety logic (submit.ts) is
 *  tested against a mock and the Mastra wrapper (agent.ts) stays a thin adapter. */
export interface HostedAgentClient {
  /** Current source text of an artifact. */
  read(shortId: string): Promise<string>
  /** Leave (or anchor) a comment. */
  comment(shortId: string, body: { body_md: string; quote?: string }): Promise<void>
  /** File a proposal — a candidate version a human approves. The below-editor write path. */
  proposeRevision(shortId: string, rev: RevisionInput): Promise<PublishResult>
  /** Publish a new version live; `requestReview` opens a review round on it. The
   *  editor write path, gated to freshness changes on opted-in workspaces. */
  publishLive(
    shortId: string,
    rev: RevisionInput,
    opts: { requestReview: boolean },
  ): Promise<PublishResult>
  /** Append a run to the ledger (WP6). Best-effort — a failed record must never
   *  fail the run it describes. org_id + agent_id are derived server-side from
   *  the bearer, so only the outcome fields travel. */
  recordRun(run: RunLedgerInput): Promise<void>
}

export interface RunLedgerInput {
  /** What fired the run (the automation's trigger, an ask, a mention). */
  reason: string
  status: "succeeded" | "failed"
  automation_id?: string | null
  cost_micro_usd?: number | null
  /** Everything else (lane, outcome, model, tokens, artifact) — an open blob, no columns. */
  meta?: Record<string, unknown> | null
}

const isoTimeout = 60_000

/** The real client over Derive's REST API. `token` is the hosted agent's bearer. */
export function httpClient(server: string, token: string): HostedAgentClient {
  const base = server.replace(/\/+$/, "")
  const auth = { authorization: `Bearer ${token}` }

  const revisionForm = (rev: RevisionInput, extra: Record<string, string> = {}): FormData => {
    const form = new FormData()
    form.set("file", new Blob([rev.content], { type: "text/html" }), rev.filename)
    if (rev.message) form.set("message", rev.message)
    if (rev.addresses?.length) form.set("addresses", JSON.stringify(rev.addresses))
    for (const [k, v] of Object.entries(extra)) form.set(k, v)
    return form
  }

  const post = async (path: string, form: FormData): Promise<PublishResult> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: auth,
      body: form,
      signal: AbortSignal.timeout(isoTimeout),
    })
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const json = (await res.json()) as {
      short_id: string
      version?: number
      current_version?: number
    }
    return { short_id: json.short_id, version: json.version ?? json.current_version ?? 0 }
  }

  return {
    async read(shortId) {
      const res = await fetch(`${base}/v1/artifacts/${shortId}/content`, {
        headers: auth,
        signal: AbortSignal.timeout(isoTimeout),
      })
      if (!res.ok) throw new Error(`read ${shortId} → ${res.status}`)
      return res.text()
    },
    async comment(shortId, body) {
      const res = await fetch(`${base}/v1/artifacts/${shortId}/comments`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(isoTimeout),
      })
      if (!res.ok) throw new Error(`comment ${shortId} → ${res.status}`)
    },
    proposeRevision(shortId, rev) {
      return post(`/v1/artifacts/${shortId}/proposals`, revisionForm(rev))
    },
    publishLive(shortId, rev, opts) {
      // A live revision is POST /v1/artifacts with the target short_id; request_review
      // opens a round on the new version. Same handler the MCP publish tool uses.
      return post(
        "/v1/artifacts",
        revisionForm(rev, {
          short_id: shortId,
          ...(opts.requestReview ? { request_review: "true" } : {}),
        }),
      )
    },
    async recordRun(run) {
      // Best-effort: the ledger is observability, never a gate on the work. A
      // failed record is logged by the caller, not thrown.
      const res = await fetch(`${base}/v1/agent/runs`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(run),
        signal: AbortSignal.timeout(isoTimeout),
      })
      if (!res.ok) throw new Error(`recordRun → ${res.status}`)
    },
  }
}
