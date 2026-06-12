export interface Me {
  id: string
  email: string
  name: string | null
  role: string
}
export interface Artifact {
  short_id: string
  url: string
  title: string | null
  kind: "file" | "bundle"
  visibility: string
  current_version: number
  versions: { n: number; author: string; message: string | null; created_at: string }[]
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
}

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
    const s = await fetch("/api/auth/get-session", { credentials: "include" }).then((r) =>
      r.ok ? r.json() : null,
    )
    if (!s?.user) throw new Error("unauthenticated")
    return { user: { id: s.user.id, email: s.user.email, name: s.user.name ?? null, role: "member" } }
  },
  login: (email: string, password: string): Promise<unknown> =>
    fetch("/api/auth/sign-in/email", opts({ email, password })).then(authJson),
  signup: (email: string, password: string, name: string): Promise<unknown> =>
    fetch("/api/auth/sign-up/email", opts({ email, password, name: name || email })).then(authJson),
  logout: () => fetch("/api/auth/sign-out", opts({})).then((r) => r.json().catch(() => ({}))),
  googleUrl: "/api/auth/sign-in/social?provider=google",

  listArtifacts: (): Promise<{ artifacts: Artifact[] }> => fetch("/v1/artifacts", opts()).then(j),
  getArtifact: (id: string): Promise<Artifact> => fetch(`/v1/artifacts/${id}`, opts()).then(j),
  getContent: (id: string, v?: number): Promise<string> =>
    fetch(`/v1/artifacts/${id}/content${v ? `?v=${v}` : ""}`, { credentials: "include" }).then((r) => r.text()),
  listComments: (id: string): Promise<{ comments: Comment[] }> =>
    fetch(`/v1/artifacts/${id}/comments`, opts()).then(j),
  comment: (id: string, body: { body_md: string; thread_id?: string; anchor?: unknown }): Promise<Comment> =>
    fetch(`/v1/artifacts/${id}/comments`, opts(body)).then(j),
  resolve: (id: string, commentId: string, state: "open" | "resolved") =>
    fetch(`/v1/artifacts/${id}/comments/${commentId}/resolve`, opts({ state })).then(j),

  async publish(file: File, fields: Record<string, string> = {}, id?: string): Promise<Artifact> {
    const fd = new FormData()
    fd.append("file", file)
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    const url = id ? `/v1/artifacts/${id}/versions` : "/v1/artifacts"
    return fetch(url, { method: "POST", body: fd, credentials: "include", headers: { accept: "application/json" } }).then(j)
  },
  publishText(id: string, text: string, filename: string, message: string): Promise<Artifact> {
    return this.publish(new File([text], filename), { message }, id)
  },
}
