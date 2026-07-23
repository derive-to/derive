import type { AutonomyFlags, Selector } from "@derive/core"

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
  /** Tag labels stamped ADDITIVELY on the write (the run's tag-targets). Sent as
   *  `add_tags`, which unions server-side — a stamp never wipes curated tags. */
  addTags?: string[]
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
  /** Create a NEW artifact through the same door. `privateDraft` creates it with
   *  workspace_access=none — visible only to the agent's registrant, who promotes
   *  it to make it real: the creation analogue of a proposal. */
  createArtifact(
    rev: RevisionInput,
    opts: { title: string; requestReview: boolean; privateDraft: boolean },
  ): Promise<PublishResult>
  /** Append a run to the ledger (WP6). Best-effort — a failed record must never
   *  fail the run it describes. org_id + agent_id are derived server-side from
   *  the bearer, so only the outcome fields travel. */
  recordRun(run: RunLedgerInput): Promise<void>
  /** Claim this agent's due queued runs — the executor pull. Each carries what to do
   *  (instruction + refs) and the gate inputs (autonomy + flags, resolved server-side and
   *  fresh at claim time), so the executor needs no extra calls to run one. */
  claimRuns(limit?: number): Promise<ClaimedRun[]>
  /** Finish a claimed run: a terminal status, the cost, and the result meta. */
  finishRun(id: string, fields: RunFinishInput): Promise<void>
}

/** A run handed to the executor by claimRuns: the work plus the resolved gate inputs. */
export interface ClaimedRun {
  id: string
  reason: string
  automation_id: string | null
  /** The automation's free-form instruction — the task to run. */
  instruction: string
  /** The automation's targets as canonical selectors: artifact = revise it,
   *  collection = file new work there, tag = stamped on every write. Each target's
   *  `mode` (publish | propose, default propose) is the user's write consent. */
  targets: Selector[]
  flags: AutonomyFlags
}

export interface RunFinishInput {
  status: "succeeded" | "failed"
  cost_micro_usd?: number | null
  meta?: Record<string, unknown> | null
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
    if (rev.addTags?.length) form.set("add_tags", JSON.stringify(rev.addTags))
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
      // A live revision is POST /v1/artifacts/:shortId/versions — the same handlePublish
      // as creation, with the target bound in the PATH. (A `short_id` form field on the
      // bare collection route is IGNORED by the handler and would CREATE a new artifact —
      // the scenario e2e caught exactly that.) request_review opens a round on the version.
      return post(
        `/v1/artifacts/${shortId}/versions`,
        revisionForm(rev, opts.requestReview ? { request_review: "true" } : {}),
      )
    },
    createArtifact(rev, opts) {
      // Creation is the SAME handler with short_id omitted. A private draft (the
      // creation analogue of a proposal) sets workspace_access=none: only the agent's
      // registrant — who owns the new artifact and gets the review round — can see it.
      return post(
        "/v1/artifacts",
        revisionForm(rev, {
          title: opts.title,
          ...(opts.requestReview ? { request_review: "true" } : {}),
          ...(opts.privateDraft ? { workspace_access: "none", link_role: "none" } : {}),
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
    async claimRuns(limit = 10) {
      const res = await fetch(`${base}/v1/agent/runs/claim?limit=${limit}`, {
        headers: auth,
        signal: AbortSignal.timeout(isoTimeout),
      })
      if (!res.ok) throw new Error(`claimRuns → ${res.status}`)
      const json = (await res.json()) as { runs: ClaimedRun[] }
      return json.runs
    },
    async finishRun(id, fields) {
      const res = await fetch(`${base}/v1/agent/runs/${id}/finish`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(isoTimeout),
      })
      if (!res.ok) throw new Error(`finishRun ${id} → ${res.status}`)
    },
  }
}
