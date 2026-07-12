/** HTTP client for a Derive server. Shared by the MCP server and any tooling. */

import type { LinkRole, Listed, WorkspaceAccess } from "@derive/core"
import { buildPublishForm } from "@derive-to/cli/publish"

/** One exact-match search/replace edit (the Edit-tool contract). */
export interface DocEdit {
  old_str: string
  new_str: string
}

export interface PublishArgs {
  /** Full content for a fresh publish/republish. Omit when using `edits` instead. */
  content?: string | Uint8Array
  filename?: string
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  /** The v2 access triple for a NEW artifact (see access-model.md); ignored on a
   *  republish. */
  workspaceAccess?: WorkspaceAccess
  linkRole?: LinkRole
  listed?: Listed
  /** A lock on the world link (optional). */
  password?: string
  /** When set, publishes a new version of this artifact instead of a new one. */
  id?: string
  /** Comment ids whose threads to resolve as part of this (re)publish. */
  resolves?: string[]
  /** Open a review round for this version (the /derive loop's ask). */
  requestReview?: boolean
  /** Exact-match search/replace against the current stored source, INSTEAD of
   *  `content` — revises without resending the whole artifact. Requires `id`. */
  edits?: DocEdit[]
  /** Safety check for `edits`: reject if the artifact moved past this version. */
  baseVersion?: number
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
  /** emoji → actor display names (the ack surface). */
  reactions?: Record<string, string[]>
}

export interface ArtifactSummaryJson {
  short_id: string
  title: string | null
  kind: "file" | "bundle"
  current_version: number
  workspace_access?: string
  link_role?: string
  listed?: string
}

/** A revision submitted for human review instead of published live. */
export interface ProposeArgs {
  /** Full content for the proposal. Omit when using `edits` instead. */
  content?: string | Uint8Array
  filename?: string
  message: string
  /** Thread ids this revision addresses (flip to `addressed`, resolve on approval). */
  addresses?: string[]
  /** Exact-match search/replace against the current stored source, INSTEAD of
   *  `content`. */
  edits?: DocEdit[]
  baseVersion?: number
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
  /** The v2 access triple (see access-model.md); optional so an older server that
   *  still returns `visibility` doesn't fail the type. */
  workspace_access?: string
  link_role?: string
  listed?: string
  current_version: number
  versions: VersionJson[]
  /** Time-grouped version view (newest-first); present on the detail endpoint. */
  sessions?: SessionJson[]
  /** Publish-response extras (agent-credentialed publishes only). */
  review_requested?: boolean
  opened_in_tab?: boolean
}

/** One review round: the human-ack primitive of the /derive loop. */
export interface ReviewRoundJson {
  id: string
  state: "pending" | "sent_back" | "approved"
  version: number
  note: string | null
  created_at: string
  resolved_at: string | null
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

export interface ContentOpts {
  version?: number
  /** A heading slug (single-file) or page path (bundle, optionally page#slug). */
  section?: string
  format?: "markdown" | "text" | "html"
}

/** A content read: the body plus the server's X-Derive-* capability headers, so a
 *  caller can tell an older self-hosted server (no headers at all) from a real
 *  raw-format response and degrade gracefully instead of misreading intent. */
export interface ContentResult {
  text: string
  /** Null when the server predates these params (no X-Derive-Format header). */
  format: string | null
  section: string | null
  sectionCount: number | null
  supportsParams: boolean
}

export interface OutlineSectionJson {
  level: number
  text: string
  slug: string
  chars: number
}

export interface DeriveClient {
  /** List the workspace's artifacts (optionally filtered by a title query). */
  list(query?: string): Promise<ArtifactSummaryJson[]>
  publish(args: PublishArgs): Promise<ArtifactJson>
  /** Submit a single-file revision for human review (does not go live). */
  propose(shortId: string, args: ProposeArgs): Promise<ProposalJson>
  get(shortId: string): Promise<ArtifactJson>
  getContent(shortId: string, opts?: ContentOpts): Promise<ContentResult>
  /** The heading (single-file) or page (bundle) outline. Empty `sections` on an
   *  older server that doesn't understand `?outline=1` (it 400s or ignores it). */
  getOutline(
    shortId: string,
    version?: number,
  ): Promise<{ sections: OutlineSectionJson[]; pages: { path: string; type?: string }[] | null }>
  listComments(shortId: string, state?: CommentState): Promise<CommentJson[]>
  createComment(shortId: string, args: NewCommentArgs): Promise<CommentJson>
  /** Resolve or reopen the thread a comment belongs to. */
  setThreadState(shortId: string, commentId: string, state: "resolved" | "open"): Promise<void>
  /** Line diff between two versions (defaults: current-1 → current). `content:
   *  "markdown"` diffs the readable Markdown form instead of raw source. */
  diff(shortId: string, from?: number, to?: number, content?: "raw" | "markdown"): Promise<DiffJson>
  /** The artifact's review rounds (newest first) + the pending one, if any. */
  getReview(
    shortId: string,
  ): Promise<{ rounds: ReviewRoundJson[]; pending: ReviewRoundJson | null }>
  /** Toggle an emoji reaction on a comment (the loop's lightweight ack). */
  react(shortId: string, commentId: string, emoji: string): Promise<void>
  /** Restore a past version as a new current revision. */
  restore(shortId: string, version: number): Promise<ArtifactJson>
  /** Aggregated view analytics. */
  viewStats(shortId: string): Promise<ViewStatsJson>
}

export interface ClientOptions {
  baseUrl: string
  token?: string
  /** Which workspace `token` acts in for this request — the token itself already
   *  reaches every workspace its owner belongs to; this just tells the server
   *  which one. Omit to fall back to the grant's own default (unchanged
   *  behavior for a plain static DERIVE_TOKEN). */
  workspace?: string
  /** Override fetch (used in tests to target an in-process server). */
  fetchImpl?: typeof fetch
}

export function createClient(opts: ClientOptions): DeriveClient {
  const base = opts.baseUrl.replace(/\/$/, "")
  const f = opts.fetchImpl ?? fetch
  const authHeaders: Record<string, string> = {
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.workspace ? { "X-Derive-Workspace": opts.workspace } : {}),
  }

  async function ok(res: Response): Promise<unknown> {
    if (res.ok) return res.json()
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`derive ${res.status}: ${body.error ?? res.statusText}`)
  }

  return {
    async list(query) {
      const q = query ? `?query=${encodeURIComponent(query)}` : ""
      const r = (await ok(await f(`${base}/v1/artifacts${q}`, { headers: authHeaders }))) as {
        artifacts: ArtifactSummaryJson[]
      }
      return r.artifacts
    },

    async publish(args) {
      // Surgical revision (args.edits) needs no file upload — the server materializes
      // it from the current stored source (requires an existing artifact, args.id).
      const bytes = args.edits
        ? undefined
        : typeof args.content === "string"
          ? new TextEncoder().encode(args.content)
          : args.content
      const form = buildPublishForm({
        bytes: bytes as Uint8Array | undefined,
        filename: args.filename,
        edits: args.edits,
        baseVersion: args.baseVersion,
        title: args.title,
        slug: args.slug,
        spa: args.spa,
        message: args.message,
        workspaceAccess: args.workspaceAccess,
        linkRole: args.linkRole,
        listed: args.listed,
        password: args.password,
        resolves: args.resolves,
        requestReview: args.requestReview,
      })
      const url = args.id ? `${base}/v1/artifacts/${args.id}/versions` : `${base}/v1/artifacts`
      return ok(
        await f(url, { method: "POST", body: form, headers: authHeaders }),
      ) as Promise<ArtifactJson>
    },

    async propose(shortId, args) {
      const form = new FormData()
      if (args.edits) {
        form.append("edits", JSON.stringify(args.edits))
        if (args.baseVersion != null) form.append("base_version", String(args.baseVersion))
      } else {
        const bytes =
          typeof args.content === "string" || args.content === undefined
            ? new TextEncoder().encode(args.content ?? "")
            : args.content
        form.append("file", new Blob([bytes as BlobPart]), args.filename ?? "index.html")
      }
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

    async getContent(shortId, opts) {
      const q = new URLSearchParams()
      if (opts?.version) q.set("v", String(opts.version))
      if (opts?.section) q.set("section", opts.section)
      if (opts?.format) q.set("format", opts.format)
      const qs = q.toString()
      const res = await f(`${base}/v1/artifacts/${shortId}/content${qs ? `?${qs}` : ""}`, {
        headers: authHeaders,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(`derive ${res.status}: ${body.error ?? res.statusText}`)
      }
      const format = res.headers.get("x-derive-format")
      return {
        text: await res.text(),
        format,
        section: res.headers.get("x-derive-section"),
        sectionCount: res.headers.has("x-derive-sections")
          ? Number(res.headers.get("x-derive-sections"))
          : null,
        // No X-Derive-Format header at all = a server that predates these params
        // (an older self-hosted instance) — the caller should treat this as raw
        // whole-artifact content and not assume format/section were honored.
        supportsParams: format !== null,
      }
    },

    async getOutline(shortId, version) {
      const q = new URLSearchParams({ outline: "1" })
      if (version) q.set("v", String(version))
      const res = await f(`${base}/v1/artifacts/${shortId}/content?${q}`, { headers: authHeaders })
      if (!res.ok) return { sections: [], pages: null }
      const body = (await res.json()) as {
        sections?: OutlineSectionJson[]
        pages?: { path: string; type?: string }[]
      }
      return { sections: body.sections ?? [], pages: body.pages ?? null }
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

    async diff(shortId, from, to, content) {
      const q = new URLSearchParams({ format: "json" })
      if (from != null) q.set("from", String(from))
      if (to != null) q.set("to", String(to))
      if (content === "markdown") q.set("content", "markdown")
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/diff?${q}`, { headers: authHeaders }),
      ) as Promise<DiffJson>
    },

    async getReview(shortId) {
      return ok(
        await f(`${base}/v1/artifacts/${shortId}/review`, { headers: authHeaders }),
      ) as Promise<{ rounds: ReviewRoundJson[]; pending: ReviewRoundJson | null }>
    },

    async react(shortId, commentId, emoji) {
      await ok(
        await f(`${base}/v1/artifacts/${shortId}/comments/${commentId}/react`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ emoji }),
        }),
      )
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
