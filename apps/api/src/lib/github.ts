// Minimal, read-only GitHub REST client for one-way sync: list a repo's tree and
// read file blobs. It only ever talks to api.github.com over HTTPS (no
// user-controlled host), so the SSRF surface that webhooks have doesn't apply.

const API = "https://api.github.com"
const UA = "dock-sync/1"
const API_VERSION = "2022-11-28"

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface RepoRef {
  owner: string
  name: string
}

/** Parse "owner/name", tolerating a github.com URL or a trailing .git. */
export function parseRepo(raw: string): RepoRef | null {
  const s = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s)
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null
}

const headers = (token: string | null, accept: string): Record<string, string> => {
  const h: Record<string, string> = {
    accept,
    "user-agent": UA,
    "x-github-api-version": API_VERSION,
  }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

const raise = async (res: Response, what: string): Promise<never> => {
  const body = await res.text().catch(() => "")
  const detail =
    res.status === 404
      ? "not found — check the repo, the branch, and that the token can read it"
      : res.status === 401 || res.status === 403
        ? "access denied or rate-limited — check the token and its scope"
        : body.slice(0, 200) || res.statusText
  throw new GitHubError(res.status, `${what}: ${detail}`)
}

export interface TreeEntry {
  path: string
  sha: string
  type: "blob" | "tree"
}

/**
 * The recursive tree at a ref (blobs only). `truncated` is true when the repo is
 * large enough that GitHub capped the listing — the caller must not treat absent
 * paths as deletions in that case.
 */
export async function listTree(
  repo: RepoRef,
  ref: string,
  token: string | null,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  const res = await fetch(url, { headers: headers(token, "application/vnd.github+json") })
  if (!res.ok) return raise(res, "listing the repo tree")
  const data = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean }
  const entries = (data.tree ?? []).filter((e): e is TreeEntry => e.type === "blob")
  return { entries, truncated: !!data.truncated }
}

/** Raw bytes of one blob by its git sha. */
export async function fetchBlob(
  repo: RepoRef,
  sha: string,
  token: string | null,
): Promise<Uint8Array> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`
  const res = await fetch(url, { headers: headers(token, "application/vnd.github.raw") })
  if (!res.ok) return raise(res, "reading a file")
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Convert one shell-style glob to an anchored, case-insensitive RegExp.
 * Supports `**` (any chars incl. slash, eating a trailing slash), `*` (any
 * run of non-slash), and `?` (one non-slash). Enough for `**\/*.md`-style
 * include patterns; not a full minimatch.
 */
const globToRe = (glob: string): RegExp => {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
        if (glob[i + 1] === "/") i++
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else if (".+^${}()|[]\\".includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`, "i")
}

/** Does a repo path match any of the include globs? */
export function matchesGlobs(path: string, globs: string[]): boolean {
  return globs.some((g) => g && globToRe(g).test(path))
}
