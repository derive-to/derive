/** HTTP client for a Dock server. Shared by the MCP server and any tooling. */

export interface PublishArgs {
  content: string | Uint8Array
  filename: string
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  /** When set, publishes a new version of this artifact instead of a new one. */
  id?: string
}

export interface ArtifactJson {
  short_id: string
  url: string
  title: string | null
  kind: "file" | "bundle"
  visibility: string
  current_version: number
  versions: { n: number; author: string; message: string | null; created_at: string }[]
}

export interface DockClient {
  publish(args: PublishArgs): Promise<ArtifactJson>
  get(shortId: string): Promise<ArtifactJson>
  getContent(shortId: string, version?: number): Promise<string>
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
    async publish(args) {
      const bytes =
        typeof args.content === "string" ? new TextEncoder().encode(args.content) : args.content
      const form = new FormData()
      form.append("file", new Blob([bytes as BlobPart]), args.filename)
      if (args.title) form.append("title", args.title)
      if (args.slug) form.append("slug", args.slug)
      if (args.message) form.append("message", args.message)
      if (args.spa) form.append("spa", "true")
      const url = args.id ? `${base}/v1/artifacts/${args.id}/versions` : `${base}/v1/artifacts`
      return ok(await f(url, { method: "POST", body: form, headers: authHeaders })) as Promise<ArtifactJson>
    },

    async get(shortId) {
      return ok(await f(`${base}/v1/artifacts/${shortId}`, { headers: authHeaders })) as Promise<ArtifactJson>
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
  }
}
