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
  /** Blob byte size (GitHub includes it on tree entries) — lets the batch fetcher
   *  skip oversized blobs (GraphQL won't return their text) and pack batches by size. */
  size?: number
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

// GitHub's secondary rate limit under concurrency is transient (403/429): honor
// Retry-After when present, else exponential backoff with jitter, a few attempts,
// then fall through to the caller's `raise` so error semantics are unchanged. Used
// by fetchBlob — the hot path that the concurrent prefetch fans out.
const RETRYABLE = new Set([403, 429])
const fetchRetrying = async (url: string, init: RequestInit, attempts = 3): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    if (res.ok || !RETRYABLE.has(res.status) || attempt >= attempts - 1) return res
    const retryAfter = Number(res.headers.get("retry-after"))
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 300 * 2 ** attempt + Math.floor(Math.random() * 200)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}

/** A GitHub commit's author, as far as the Commits API reveals it. `login`/`ghId`/
 *  `avatar` come from the TOP-LEVEL `author` (the GitHub account; null when GitHub can't
 *  map the commit email to one); `name`/`email` come from `commit.author` (the raw git
 *  identity, always present). All fields nullable so a partial commit never throws. */
export interface CommitAuthor {
  login: string | null
  ghId: string | null
  name: string | null
  email: string | null
  avatar: string | null
}

/** The shape of one element of the Commits API list response (the bits we read). */
interface CommitListEntry {
  commit?: {
    committer?: { date?: string }
    author?: { name?: string; email?: string }
  }
  author?: { login?: string; id?: number; avatar_url?: string } | null
}

/** Pure parser: turn the Commits API list response into the committer date + author.
 *  Exported for unit testing the extraction without a network round-trip. Empty/missing
 *  history → { date: null, author: null }. */
export function parseLastCommit(data: CommitListEntry[] | null | undefined): {
  date: string | null
  author: CommitAuthor | null
} {
  const head = data?.[0]
  if (!head) return { date: null, author: null }
  const date = head.commit?.committer?.date ?? null
  const top = head.author ?? null
  const git = head.commit?.author ?? null
  // No identity at all (neither the GitHub account nor the raw git author) → null author.
  if (!top && !git?.name && !git?.email) return { date, author: null }
  return {
    date,
    author: {
      login: top?.login ?? null,
      ghId: top?.id != null ? String(top.id) : null,
      avatar: top?.avatar_url ?? null,
      name: git?.name ?? null,
      email: git?.email ?? null,
    },
  }
}

/**
 * The most recent commit that touched `path` on `ref`: its committer date (the file's
 * true last-change time, driving a synced artifact's "updated") AND its author. The git
 * tree carries neither, so this is a separate Commits API call. Best-effort: returns
 * { date: null, author: null } on any error or an empty history so a sync never fails.
 */
export async function lastCommit(
  repo: RepoRef,
  path: string,
  ref: string,
  token: string | null,
): Promise<{ date: string | null; author: CommitAuthor | null }> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/commits?path=${encodeURIComponent(
    path,
  )}&sha=${encodeURIComponent(ref)}&per_page=1`
  try {
    const res = await fetchRetrying(url, { headers: headers(token, "application/vnd.github+json") })
    if (!res.ok) return { date: null, author: null }
    return parseLastCommit((await res.json()) as CommitListEntry[])
  } catch {
    return { date: null, author: null }
  }
}

/**
 * The committer date of the most recent commit that touched `path` on `ref` — a thin
 * wrapper over {@link lastCommit} kept for callers that only need the date. Best-effort:
 * null on any error or empty history.
 */
export async function lastCommitDate(
  repo: RepoRef,
  path: string,
  ref: string,
  token: string | null,
): Promise<string | null> {
  return (await lastCommit(repo, path, ref, token)).date
}

/** Raw bytes of one blob by its git sha. */
export async function fetchBlob(
  repo: RepoRef,
  sha: string,
  token: string | null,
): Promise<Uint8Array> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`
  const res = await fetchRetrying(url, { headers: headers(token, "application/vnd.github.raw") })
  if (!res.ok) return raise(res, "reading a file")
  return new Uint8Array(await res.arrayBuffer())
}

/** One entry of the Pull Request Files API (the bits we read). */
interface PullFileEntry {
  filename?: string
  status?: string
}

/**
 * The paths a pull request changes that STILL EXIST on its head — added, modified,
 * renamed-to, or copied; `removed` files are dropped because a preview only mirrors
 * what's present on the head. Read-only, needs the `pull_requests: read` permission.
 * Paginated 100/page; capped at ~1000 changed files (GitHub itself caps the list at
 * 3000). Errors flow through `raise` for a clean, caller-facing message.
 */
export async function listPullFiles(
  repo: RepoRef,
  prNumber: number,
  token: string | null,
): Promise<string[]> {
  const out: string[] = []
  for (let page = 1; page <= 10; page++) {
    const url = `${API}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/files?per_page=100&page=${page}`
    const res = await fetchRetrying(url, { headers: headers(token, "application/vnd.github+json") })
    if (!res.ok) return raise(res, "listing pull request files")
    const data = (await res.json()) as PullFileEntry[]
    for (const f of data) if (f.status !== "removed" && f.filename) out.push(f.filename)
    if (data.length < 100) break
  }
  return out
}

const GRAPHQL = `${API}/graphql`

/**
 * Fetch many TEXT blobs in ONE GraphQL request, aliased by git oid (the tree shas).
 * Returns sha → bytes for the text blobs only; binary blobs, blobs too large for
 * GraphQL to return `text`, and any whole-query failure are omitted, so the caller
 * falls back to the per-blob REST endpoint for those (correctness-preserving). A
 * 25-file query is ~1 rate-limit point and one round-trip instead of 25 of each —
 * the cheap, GitHub-preferred way to read many files (vs. fanning out single GETs).
 */
export async function fetchBlobsBatch(
  repo: RepoRef,
  shas: readonly string[],
  token: string | null,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  const unique = [...new Set(shas)]
  if (unique.length === 0) return out
  // One aliased Blob per oid: a0: object(oid:"…") { ... on Blob { text isBinary } }
  const fields = unique
    .map((sha, i) => `a${i}:object(oid:${JSON.stringify(sha)}){...on Blob{text isBinary}}`)
    .join(" ")
  const query = `query($o:String!,$n:String!){repository(owner:$o,name:$n){${fields}}}`
  let res: Response
  try {
    res = await fetchRetrying(GRAPHQL, {
      method: "POST",
      headers: { ...headers(token, "application/json"), "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { o: repo.owner, n: repo.name } }),
    })
  } catch {
    return out // network blip — the lazy REST path re-fetches these
  }
  if (!res.ok) return out
  const json = (await res.json().catch(() => null)) as {
    data?: {
      repository?: Record<string, { text?: string | null; isBinary?: boolean | null } | null>
    }
  } | null
  const repository = json?.data?.repository
  if (!repository) return out
  const enc = new TextEncoder()
  unique.forEach((sha, i) => {
    const blob = repository[`a${i}`]
    if (blob && !blob.isBinary && typeof blob.text === "string") out.set(sha, enc.encode(blob.text))
  })
  return out
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
    else if (".+^(){}|[]$\\".includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`, "i")
}

/** Does a repo path match any of the include globs? */
export function matchesGlobs(path: string, globs: string[]): boolean {
  return globs.some((g) => g && globToRe(g).test(path))
}
