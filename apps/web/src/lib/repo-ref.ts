// The client's copy of the repository reference grammar (packages/core/src/repo-ref.ts).
// The web never imports core at runtime, and the import form wants to say
// "github.com/owner/repo" or "Not a GitHub or GitLab repository" as the person types,
// before the server is asked. The server's parser is the one that decides; this only
// previews, and is kept to the same table of cases as core's test.

export interface RepoRefPreview {
  canonical: string
  /** The repository's page on its own host. */
  webUrl: string
}

const PART = /^[a-z0-9_][a-z0-9_.-]*$/i
const REF = /^[a-z0-9_][a-z0-9_./-]*$/i

const isGitLabHost = (hostname: string): boolean =>
  hostname.split(".").includes("gitlab") || hostname === "gitlab.com"

export const previewRepoRef = (input: string): RepoRefPreview | null => {
  let s = input.trim()
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim()
  let end = s.length
  while (end > 0 && ".,;:)]".includes(s[end - 1] ?? "")) end--
  s = s.slice(0, end)
  if (!s || /[^\x20-\x7e]/.test(s) || /\s/.test(s)) return null

  const scp = /^(?:[a-z0-9_.-]+@)?([a-z0-9.-]+):(?!\/)(.+)$/i.exec(s)
  if (scp) s = `https://${scp[1]}/${scp[2]}`
  else if (/^(?:git|ssh|http):\/\//i.test(s)) s = s.replace(/^[a-z]+:\/\//i, "https://")
  else if (!/^https:\/\//i.test(s)) {
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
  const github = hostname === "github.com" || hostname === "www.github.com"
  if (!github && !isGitLabHost(hostname)) return null

  let rest: string[]
  try {
    rest = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  const dash = github ? -1 : rest.indexOf("-")
  const head = dash === -1 ? rest : rest.slice(0, dash)
  const tail = dash === -1 ? [] : rest.slice(dash + 1)
  const browse = dash === -1 ? head.indexOf("tree") : tail[0] === "tree" ? 0 : -1
  let ref: string | null = null
  let path = head
  if (dash === -1) {
    if (browse !== -1) {
      ref = head[browse + 1] ?? null
      path = head.slice(0, browse)
    }
  } else if (browse === 0) ref = tail[1] ?? null
  if (path.length < 2) return null
  const name = (path.at(-1) as string).replace(/\.git$/i, "")
  const parts = [...path.slice(0, -1), name]
  if (!parts.every((p) => PART.test(p))) return null
  if (github && parts.length !== 2) return null
  if (ref !== null && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/"))) return null
  const origin = `https://${github ? "github.com" : hostname}`
  const owner = parts.slice(0, -1).join("/")
  return {
    canonical: `${origin.replace(/^https:\/\//, "")}/${owner}/${name}${ref ? `@${ref}` : ""}`,
    webUrl: `${origin}/${owner}/${name}${ref ? `/tree/${ref}` : ""}`,
  }
}
