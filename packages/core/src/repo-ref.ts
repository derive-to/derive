/**
 * Public code repository references, the way people paste them.
 *
 * An imported paper may carry the repository that implements it, so an agent reading the
 * paper can read the code beside it. The link arrives as untrusted text and becomes the
 * host, path and ref of a request Derive makes, so the grammar here is strict rather than
 * forgiving, the same stance as `parseArxivRef`: an exact rule per host, a fixed path
 * shape, ASCII only, and "not a repository link" rather than a best guess.
 *
 * Two hosts are recognised, because those are the two that publish a plain tarball of a
 * repository over anonymous HTTPS. GitHub is matched by name. GitLab is self-hosted as
 * often as not (a lab's own instance), so it is matched by a `gitlab` label anywhere in
 * the hostname; a GitLab living under some other name is not recognised, and a submodule
 * on one is reported as skipped with its URL rather than fetched from a guess.
 *
 * `repoArchiveUrl` is the only place a request URL is built from a reference, so pasted
 * text can never steer a fetch to another host or path.
 */

export type RepoHost = "github" | "gitlab"

export interface RepoRef {
  host: RepoHost
  /** Scheme and host, no trailing slash (`https://github.com`). */
  origin: string
  /** The owner, or a GitLab group path that may itself contain slashes. */
  owner: string
  /** The project name, without `.git`. */
  name: string
  /** The branch or tag the link pinned; null means the repository's default branch. */
  ref: string | null
  /** `github.com/owner/name`, plus `@ref` when one was pinned. */
  canonical: string
}

/** One path segment of an owner or project name. GitHub allows letters, digits, dot,
 *  dash and underscore; GitLab adds nothing this needs. Leading dots are refused so a
 *  segment can never be `.` or `..`. */
const PART = /^[a-z0-9_][a-z0-9_.-]*$/i

/** A branch or tag: no control characters, no space, and nothing that could leave the
 *  path it is interpolated into. */
const REF = /^[a-z0-9_][a-z0-9_./-]*$/i

const isGitLabHost = (hostname: string): boolean =>
  hostname.split(".").includes("gitlab") || hostname === "gitlab.com"

const build = (host: RepoHost, origin: string, owner: string, name: string, ref: string | null) => {
  const parts = [...owner.split("/"), name]
  if (parts.length < 2 || !parts.every((p) => PART.test(p))) return null
  if (host === "github" && parts.length !== 2) return null
  if (ref !== null && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/"))) return null
  const shownHost = origin.replace(/^https:\/\//, "")
  return {
    host,
    origin,
    owner,
    name,
    ref,
    canonical: `${shownHost}/${owner}/${name}${ref ? `@${ref}` : ""}`,
  } satisfies RepoRef
}

/** Split a repository path into owner, project and the ref a browse link pinned.
 *  A link into a subdirectory keeps its branch and drops the path: the whole repository
 *  is fetched either way. A branch whose name contains a slash cannot be told apart from
 *  such a path, so only its first segment survives; paste the plain repository link to
 *  get its default branch instead. */
const splitPath = (
  pathname: string,
  host: RepoHost,
): { owner: string; name: string; ref: string | null } | null => {
  let rest: string[]
  try {
    rest = pathname.split("/").filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (rest.length < 2) return null
  // GitLab separates the project from what you are doing to it with `/-/`.
  const dash = host === "gitlab" ? rest.indexOf("-") : -1
  const head = dash === -1 ? rest : rest.slice(0, dash)
  const tail = dash === -1 ? [] : rest.slice(dash + 1)
  // github.com/o/r/tree/<ref>/... — on GitLab the same shape lives after the `/-/`.
  const browse = dash === -1 ? head.indexOf("tree") : tail[0] === "tree" ? 0 : -1
  let ref: string | null = null
  let path = head
  if (dash === -1) {
    if (browse !== -1) {
      ref = head[browse + 1] ?? null
      path = head.slice(0, browse)
    }
  } else if (browse === 0) {
    ref = tail[1] ?? null
  }
  if (path.length < 2) return null
  const name = (path.at(-1) as string).replace(/\.git$/i, "")
  return { owner: path.slice(0, -1).join("/"), name, ref }
}

/**
 * Parse a pasted repository reference. Null means "not a repository link", which the
 * caller shows verbatim rather than guessing. Accepts an https link, the `git@host:path`
 * and `git://` forms a `.gitmodules` file carries, and the bare `owner/repo` shorthand
 * for GitHub.
 */
export const parseRepoRef = (input: string): RepoRef | null => {
  let s = input.trim()
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim()
  s = s.replace(/[.,;:)\]]+$/, "")
  if (!s || /[^\x20-\x7e]/.test(s) || /\s/.test(s)) return null

  // scp-style `git@github.com:owner/repo.git`, the usual .gitmodules form.
  const scp = /^(?:[a-z0-9_.-]+@)?([a-z0-9.-]+):(?!\/)(.+)$/i.exec(s)
  if (scp) s = `https://${scp[1]}/${scp[2]}`
  else if (/^(?:git|ssh|http):\/\//i.test(s)) s = s.replace(/^[a-z]+:\/\//i, "https://")
  else if (!/^https:\/\//i.test(s)) {
    // Bare `owner/repo` is GitHub's own shorthand; a bare host with a path is a link.
    const bareHost = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i.exec(s)
    s = bareHost ? `https://${s}` : `https://github.com/${s}`
  }

  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null
  const hostname = url.hostname.toLowerCase()
  const host: RepoHost | null =
    hostname === "github.com" || hostname === "www.github.com"
      ? "github"
      : isGitLabHost(hostname)
        ? "gitlab"
        : null
  if (!host) return null
  const split = splitPath(url.pathname, host)
  if (!split) return null
  const origin = `https://${host === "github" ? "github.com" : hostname}`
  return build(host, origin, split.owner, split.name, split.ref)
}

/**
 * The one URL a repository is fetched from: a gzipped tarball of the whole tree at one
 * ref, served to anonymous clients. `HEAD` means the default branch, which saves asking
 * an API what that branch is called.
 */
export const repoArchiveUrl = (ref: RepoRef): string => {
  const at = ref.ref ?? "HEAD"
  if (ref.host === "github")
    return `https://codeload.github.com/${ref.owner}/${ref.name}/tar.gz/${at}`
  return `${ref.origin}/${ref.owner}/${ref.name}/-/archive/${at}/${ref.name}-${at}.tar.gz`
}

/** Where a person opens the repository: its page on its own host. */
export const repoWebUrl = (ref: RepoRef): string =>
  `${ref.origin}/${ref.owner}/${ref.name}${ref.ref ? `/tree/${ref.ref}` : ""}`

export interface Submodule {
  /** Where the submodule sits in the parent tree, slash-free of leading `./`. */
  path: string
  /** The URL as written, kept verbatim so an unsupported host can be reported. */
  url: string
  /** The branch `.gitmodules` names, when it names one. */
  branch: string | null
}

/** `../other.git` beside `host/owner/name` is `host/owner/other`, the way git resolves a
 *  relative submodule URL against its parent's own location. */
const resolveRelative = (relative: string, parent: RepoRef): string | null => {
  const base = [...parent.owner.split("/"), parent.name]
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (base.length === 0) return null
      base.pop()
      continue
    }
    base.push(part)
  }
  if (base.length < 2) return null
  return `${parent.origin}/${base.join("/")}`
}

/**
 * Parse a `.gitmodules` file. A tarball carries this file but not the commits its
 * submodules are pinned to, so the branch named here (or the default) is the best a
 * tarball fetch can do, and the caller says so in its notes.
 *
 * A relative URL (`../sibling.git`, how a group of repositories on one host refer to each
 * other) is resolved against the parent's own location.
 */
export const parseGitmodules = (text: string, parent?: RepoRef): Submodule[] => {
  const out: Submodule[] = []
  let current: { path?: string; url?: string; branch?: string } | null = null
  const flush = (): void => {
    const entry = current
    current = null
    if (!entry?.path || !entry.url) return
    const path = entry.path.replace(/^\.?\//, "").replace(/\/+$/, "")
    if (!path || path.split("/").some((p) => p === "." || p === "..")) return
    out.push({ path, url: entry.url, branch: entry.branch ?? null })
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    if (/^\[submodule\b/i.test(line)) {
      flush()
      current = {}
      continue
    }
    const kv = /^(path|url|branch)\s*=\s*(.+)$/i.exec(line)
    if (!kv || !current) continue
    const key = (kv[1] as string).toLowerCase() as "path" | "url" | "branch"
    const value = (kv[2] as string).trim().replace(/^["']|["']$/g, "")
    if (value) current[key] = value
  }
  flush()
  if (!parent) return out
  return out.map((s) =>
    /^\.{1,2}\//.test(s.url) ? { ...s, url: resolveRelative(s.url, parent) ?? s.url } : s,
  )
}
