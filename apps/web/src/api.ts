export interface Me {
  id: string
  email: string
  name: string | null
  role: string
}
export interface VersionSession {
  n: number
  from_n: number
  count: number
  author: string
  name: string | null
  created_at: string
}
export type Role = "viewer" | "commenter" | "editor" | "owner"
export interface Artifact {
  short_id: string
  url: string
  title: string | null
  kind: "file" | "bundle"
  visibility: string
  current_version: number
  versions: {
    n: number
    author: string
    message: string | null
    name: string | null
    created_at: string
  }[]
  /** Time-grouped view of versions for display; newest-first. */
  sessions?: VersionSession[]
  views?: number
  /** The current caller's effective role on this artifact (null = no access). */
  my_role?: Role | null
  /** Browse tags (workspace-wide). */
  tags?: string[]
  /** Whether the current user has starred this artifact. */
  favorite?: boolean
  /** Count of proposals awaiting review. */
  open_proposals?: number
  /** Count of non-withdrawn proposals (open + decided) — gates the Proposals entry. */
  proposals_total?: number
}
export type ProposalState = "open" | "approved" | "changes_requested" | "withdrawn"
export interface Proposal {
  id: string
  state: ProposalState
  author: string
  message: string | null
  base_version: number
  kind: "file" | "bundle"
  decided_by: string | null
  decided_version: number | null
  /** The reviewer's feedback when approving or requesting changes. */
  decision_note: string | null
  decided_at: string | null
  created_at: string
  /** The proposed experience, rendered exactly like a live version. */
  preview_url: string
  /** Present on the single-proposal fetch: line diff vs the base version. */
  diff?: { base_version: number; ops: DiffOp[] }
}
export interface ArtifactMember {
  user_id: string
  email: string | null
  name: string | null
  role: Role
}
export interface Analytics {
  total: number
  unique: number
  perVersion: { version: number; count: number }[]
  daily: { day: string; count: number }[]
  recent: { viewer: string; kind: "user" | "anon"; at: string }[]
}
export interface Comment {
  id: string
  thread_id: string
  base_version: number
  path: string | null
  anchor: string | null
  body_md: string
  author: string
  state: "open" | "resolved"
  created_at: string
  anchored?: boolean
  reactions?: Record<string, string[]>
  edited?: boolean
  edited_at?: string | null
  deleted?: boolean
}
export interface Webhook {
  id: string
  artifact_id: string | null
  url: string
  kind: "generic" | "slack"
  events: string
  label: string | null
  active: 0 | 1
  created_at: string
}
export interface Delivery {
  id: string
  event_type: string
  status: "pending" | "delivered" | "dead"
  attempts: number
  last_error: string | null
  created_at: string
}
export interface DiffOp {
  t: "ctx" | "add" | "del"
  line: string
}
export interface Diff {
  from: number
  to: number
  ops: DiffOp[]
}

// Same-origin by default (dev proxy / embedded self-host). Set VITE_DOCK_API to
// the API origin when the SPA is served from a CDN separate from the container.
export const API_BASE = (import.meta.env.VITE_DOCK_API ?? "").replace(/\/$/, "")
const u = (path: string) => API_BASE + path
const f = (path: string, init?: RequestInit) => fetch(u(path), init)

const j = async (r: Response) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
  return r.json()
}
const opts = (body?: unknown): RequestInit => ({
  credentials: "include",
  headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
})

// Better Auth lives under /api/auth; get-session returns { user } | null.
const authJson = async (r: Response) => {
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.message ?? data?.error?.message ?? `HTTP ${r.status}`)
  return data
}

export const api = {
  async me(): Promise<{ user: Me }> {
    const s = await f("/api/auth/get-session", { credentials: "include" }).then((r) =>
      r.ok ? r.json() : null,
    )
    if (!s?.user) throw new Error("unauthenticated")
    return {
      user: { id: s.user.id, email: s.user.email, name: s.user.name ?? null, role: "member" },
    }
  },
  login: (email: string, password: string): Promise<unknown> =>
    f("/api/auth/sign-in/email", opts({ email, password })).then(authJson),
  signup: (email: string, password: string, name: string): Promise<unknown> =>
    f("/api/auth/sign-up/email", opts({ email, password, name: name || email })).then(authJson),
  logout: () => f("/api/auth/sign-out", opts({})).then((r) => r.json().catch(() => ({}))),
  googleUrl: u("/api/auth/sign-in/social?provider=google"),

  listArtifacts: (params?: {
    q?: string
    tag?: string
    favorite?: boolean
    cursor?: string
    limit?: number
  }): Promise<{ artifacts: Artifact[]; next_cursor: string | null }> => {
    const qs = new URLSearchParams()
    if (params?.q) qs.set("q", params.q)
    if (params?.tag) qs.set("tag", params.tag)
    if (params?.favorite) qs.set("favorite", "true")
    if (params?.cursor) qs.set("cursor", params.cursor)
    if (params?.limit) qs.set("limit", String(params.limit))
    const s = qs.toString()
    return f(`/v1/artifacts${s ? `?${s}` : ""}`, opts()).then(j)
  },
  browseSummary: (): Promise<{
    total: number
    favorites: number
    tags: { tag: string; count: number }[]
  }> => f("/v1/tags", opts()).then(j),
  getArtifact: (id: string): Promise<Artifact> => f(`/v1/artifacts/${id}`, opts()).then(j),
  getContent: (id: string, v?: number): Promise<string> =>
    f(`/v1/artifacts/${id}/content${v ? `?v=${v}` : ""}`, { credentials: "include" }).then((r) =>
      r.text(),
    ),
  diff: (id: string, from: number, to: number): Promise<Diff> =>
    f(`/v1/artifacts/${id}/diff?from=${from}&to=${to}&format=json`, opts()).then(j),
  restore: (id: string, version: number): Promise<Artifact> =>
    f(`/v1/artifacts/${id}/restore`, opts({ version })).then(j),

  listProposals: (id: string, state?: ProposalState): Promise<{ proposals: Proposal[] }> =>
    f(`/v1/artifacts/${id}/proposals${state ? `?state=${state}` : ""}`, opts()).then(j),
  getProposal: (id: string, proposalId: string): Promise<Proposal> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}`, opts()).then(j),
  propose(id: string, text: string, filename: string, message: string): Promise<Proposal> {
    const fd = new FormData()
    fd.append("file", new File([text], filename))
    if (message) fd.append("message", message)
    return f(`/v1/artifacts/${id}/proposals`, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },
  approveProposal: (
    id: string,
    proposalId: string,
    note?: string,
  ): Promise<Proposal & { published: number }> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}/approve`, opts({ note })).then(j),
  requestChanges: (id: string, proposalId: string, note?: string): Promise<Proposal> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}/request-changes`, opts({ note })).then(j),
  withdrawProposal: (id: string, proposalId: string): Promise<Proposal> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}/withdraw`, opts({})).then(j),

  listMembers: (id: string): Promise<{ default_role: Role; members: ArtifactMember[] }> =>
    f(`/v1/artifacts/${id}/members`, opts()).then(j),
  setMember: (id: string, email: string, role: Role): Promise<ArtifactMember> =>
    f(`/v1/artifacts/${id}/members`, { ...opts({ email, role }), method: "PUT" }).then(j),
  removeMember: (id: string, userId: string): Promise<void> =>
    f(`/v1/artifacts/${id}/members/${userId}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),
  heartbeat: (id: string, name: string): Promise<{ viewers: string[] }> =>
    f(`/v1/artifacts/${id}/presence`, opts({ name })).then(j),

  favorite: (id: string, on: boolean): Promise<{ favorite: boolean }> =>
    f(`/v1/artifacts/${id}/favorite`, { ...opts(), method: on ? "PUT" : "DELETE" }).then(j),
  setTags: (id: string, tags: string[]): Promise<{ tags: string[] }> =>
    f(`/v1/artifacts/${id}/tags`, { ...opts({ tags }), method: "PUT" }).then(j),

  listWebhooks: (): Promise<{ webhooks: Webhook[] }> => f("/v1/webhooks", opts()).then(j),
  createWebhook: (body: {
    url: string
    kind: "generic" | "slack"
    events?: string[]
    label?: string
    artifact?: string
  }): Promise<Webhook> => f("/v1/webhooks", opts(body)).then(j),
  deleteWebhook: (id: string): Promise<void> =>
    f(`/v1/webhooks/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),
  testWebhook: (id: string): Promise<unknown> => f(`/v1/webhooks/${id}/test`, opts({})).then(j),
  webhookDeliveries: (id: string): Promise<{ deliveries: Delivery[] }> =>
    f(`/v1/webhooks/${id}/deliveries`, opts()).then(j),
  recordView: (id: string, version?: number): Promise<void> =>
    f(`/v1/artifacts/${id}/view`, opts({ version })).then(() => undefined),
  analytics: (id: string): Promise<Analytics> => f(`/v1/artifacts/${id}/analytics`, opts()).then(j),
  listComments: (id: string): Promise<{ comments: Comment[] }> =>
    f(`/v1/artifacts/${id}/comments`, opts()).then(j),
  comment: (
    id: string,
    body: { body_md: string; thread_id?: string; anchor?: unknown },
  ): Promise<Comment> => f(`/v1/artifacts/${id}/comments`, opts(body)).then(j),
  resolve: (id: string, commentId: string, state: "open" | "resolved") =>
    f(`/v1/artifacts/${id}/comments/${commentId}/resolve`, opts({ state })).then(j),
  react: (id: string, commentId: string, emoji: string): Promise<Comment> =>
    f(`/v1/artifacts/${id}/comments/${commentId}/react`, opts({ emoji })).then(j),
  editComment: (id: string, commentId: string, body_md: string): Promise<Comment> =>
    f(`/v1/artifacts/${id}/comments/${commentId}`, { ...opts({ body_md }), method: "PATCH" }).then(
      j,
    ),
  deleteComment: (id: string, commentId: string): Promise<Comment> =>
    f(`/v1/artifacts/${id}/comments/${commentId}`, {
      method: "DELETE",
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j),

  async publish(file: File, fields: Record<string, string> = {}, id?: string): Promise<Artifact> {
    const fd = new FormData()
    fd.append("file", file)
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    const path = id ? `/v1/artifacts/${id}/versions` : "/v1/artifacts"
    return f(path, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },
  publishText(id: string, text: string, filename: string, message: string): Promise<Artifact> {
    return this.publish(new File([text], filename), { message }, id)
  },
}
