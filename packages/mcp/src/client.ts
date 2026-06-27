/** HTTP client for a Dock server. Shared by the MCP server and any tooling. */

export interface PublishArgs {
  content: string | Uint8Array
  filename: string
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  visibility?: "public" | "link" | "org" | "password"
  /** Unlock password, required when visibility is "password". */
  password?: string
  /** When set, publishes a new version of this artifact instead of a new one. */
  id?: string
  /** Comment ids whose threads to resolve as part of this (re)publish. */
  resolves?: string[]
}

export type CommentState = "open" | "addressed" | "resolved" | "outdated"

export interface CommentJson {
  id: string
  thread_id: string
  base_version: number
  path: string | null
  anchor: string | null
  body_md: string
  author: string
  state: CommentState
  created_at: string
}

export interface ArtifactSummaryJson {
  short_id: string
  title: string | null
  kind: "file" | "bundle"
  current_version: number
  visibility: string
}

/** A revision submitted for human review instead of published live. */
export interface ProposeArgs {
  content: string
  filename?: string
  message: string
  /** Thread ids this revision addresses (flip to `addressed`, resolve on approval). */
  addresses?: string[]
}
export interface ProposalJson {
  id: string
  base_version: number
  addressed?: string[]
}

export interface NewCommentArgs {
  body_md: string
  thread_id?: string
  author?: string
  base_version?: number
  path?: string
  anchor?: unknown
}

export interface VersionJson {
  n: number
  author: string
  message: string | null
  name: string | null
  created_at: string
}
export interface SessionJson {
  n: number
  from_n: number
  count: number
  author: string
  name: string | null
  created_at: string
}
export interface ArtifactJson {
  short_id: string
  url: string
  title: string | null
  kind: "file" | "bundle"
  visibility: string
  current_version: number
  versions: VersionJson[]
  /** Time-grouped version view (newest-first); present on the detail endpoint. */
  sessions?: SessionJson[]
}

export interface DiffOpJson {
  t: "ctx" | "add" | "del"
  line: string
}
export interface DiffJson {
  from: number
  to: number
  ops: DiffOpJson[]
}

export interface ViewStatsJson {
  total: number
  unique: number
  perVersion: { version: number; count: number }[]
  daily: { day: string; count: number }[]
  recent: { viewer: string; kind: "user" | "anon"; at: string }[]
}

export interface DockClient {
  /** List the workspace's artifacts (optionally filtered by a title query). */
  list(query?: string): Promise<ArtifactSummaryJson[]>
  publish(args: PublishArgs): Promise<ArtifactJson>
  /** Submit a single-file revision for human review (does not go live). */
  propose(shortId: string, args: ProposeArgs): Promise<ProposalJson>
  get(shortId: string): Promise<ArtifactJson>
  getContent(shortId: string, version?: number): Promise<string>
  listComments(shortId: string, state?: CommentState): Promise<CommentJson[]>
  createComment(shortId: string, args: NewCommentArgs): Promise<CommentJson>
  /** Resolve or reopen the thread a comment belongs to. */
  setThreadState(shortId: string, commentId: string, state: "resolved" | "open"): Promise<void>
  /** Line diff between two versions (defaults: current-1 → current). */
  diff(shortId: string, from?: number, to?: number): Promise<DiffJson>
  /** Restore a past version as a new current revision. */
  restore(shortId: string, version: number): Promise<ArtifactJson>
  /** Aggregated view analytics. */
  viewStats(shortId: string): Promise<ViewStatsJson>
}

export interface ClientOptions {
  baseUrl: string
  token?: string
  /** Override fetch (used in tests to target an in-process server). */
  fetchImpl?: typeof fetch
}

export function createClient(opts: ClientOptions): DockClient {
  const base = opts.baseUrl.replace(/\/$/, "")
  const f = opts.fetchImpl ?? fetch
  const authHeaders: Record<string, string> = opts.token
    ? { Authorization: `Bearer ${opts.token}` }
    : {}

  async function ok(res: Response): Promise<unknown> {
    if (res.ok) return res.json()
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`dock ${res.status}: ${body.error ?? res.statusText}`)
  }

  return {
    async list(query) {
      const q = query ? `?q=${encodeURIComponent(query)}` : ""
      const r = (await ok(await f(`${base}/v1/artifacts${q}`, { headers: authHeaders }))) as {
        artifacts: ArtifactSummaryJson[]
      }
      return r.artifacts
    },

    async publish(args) {
      const bytes =
        typeof args.content === "string" ? new TextEncoder().encode(args.content) : args.content
      const form = new FormData()
      form.append("file", new Blob([bytes as BlobPart]), args.filename)
      if (args.title) form.append("title", args.title)
      if (args.slug) form.append("slug", args.slug)
      if (args.message) form.append("message", args.message)
      if (args.visibility) form.append("visibility", args.visibility)
      if (args.password) form.append("password", args.password)
      if (args.spa) form.append("spa", "true")
      if (args.resolves?.length) form.append("resolves", args.resolves.join(","))
      const url = args.id ? `${base}/v1/artifacts/${args.id}/versions` : `${base}/v1/artifacts`
      return ok(
        await f(url, { method: "POST", body: form, headers: authHeaders }),
      ) as Promise<ArtifactJson>
    },

    async propose(shortId, args) {
      const form = new FormData()
      form.append(
        "file",
        new Blob([new TextEncoder().encode(args.content)]),
        args.filename ?? "index.html",
      )
      form.append("message", args.message)
      if (args.addresses?.length) form.append("addresses", args.addresses.join(","))
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/proposals`, {
          method: "POST",
          body: form,
          headers: authHeaders,
        }),
      ) as Promise<ProposalJson>
    },

    async get(shortId) {
      return ok(
        await f(`${base}/v1/artifacts/${shortId}`, { headers: authHeaders }),
      ) as Promise<ArtifactJson>
    },

    async getContent(shortId, version) {
      const q = version ? `?v=${version}` : ""
      const res = await f(`${base}/v1/artifacts/${shortId}/content${q}`, { headers: authHeaders })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(`dock ${res.status}: ${body.error ?? res.statusText}`)
      }
      return res.text()
    },

    async listComments(shortId, state) {
      const q = state ? `?state=${state}` : ""
      const r = (await ok(
        await f(`${base}/v1/artifacts/${shortId}/comments${q}`, { headers: authHeaders }),
      )) as { comments: CommentJson[] }
      return r.comments
    },

    async createComment(shortId, args) {
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/comments`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ) as Promise<CommentJson>
    },

    async setThreadState(shortId, commentId, state) {
      await ok(
        await f(`${base}/v1/artifacts/${shortId}/comments/${commentId}/resolve`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ state }),
        }),
      )
    },

    async diff(shortId, from, to) {
      const q = new URLSearchParams({ format: "json" })
      if (from != null) q.set("from", String(from))
      if (to != null) q.set("to", String(to))
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/diff?${q}`, { headers: authHeaders }),
      ) as Promise<DiffJson>
    },

    async restore(shortId, version) {
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/restore`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ version }),
        }),
      ) as Promise<ArtifactJson>
    },

    async viewStats(shortId) {
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/analytics`, { headers: authHeaders }),
      ) as Promise<ViewStatsJson>
    },
  }
}
