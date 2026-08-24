const REPO_PART = "[A-Za-z0-9_.-]+"
const NUMBER = "[1-9][0-9]*"

const listRepos = /^\/installation\/repositories$/
const listPulls = new RegExp(`^/repos/${REPO_PART}/${REPO_PART}/pulls$`)
const getPull = new RegExp(`^/repos/${REPO_PART}/${REPO_PART}/pulls/${NUMBER}$`)
const listPullFiles = new RegExp(`^/repos/${REPO_PART}/${REPO_PART}/pulls/${NUMBER}/files$`)
const pullComments = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/issues/(${NUMBER})/comments$`,
)

const queryKeys = (url: URL): Set<string> => new Set(url.searchParams.keys())
const onlyQueryKeys = (url: URL, allowed: readonly string[]): boolean => {
  const allowedSet = new Set(allowed)
  return [...queryKeys(url)].every((key) => allowedSet.has(key))
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

export interface GithubSourcePolicy {
  /** The only HTTP verbs the frozen direct-tool surface can advertise. */
  verb: "GET" | "POST"
  /** For comment writes, the PR endpoint used to prove the issue number is a PR. */
  prPreflightPath?: string
}

/**
 * The effective GitHub source boundary. The App permission must be write-level to create a
 * PR conversation comment, but that vendor scope is broader than the product contract. This
 * policy is therefore checked before token minting and before any network request.
 *
 * Keep this list deliberately small: PR discovery/detail/files, PR conversation reads, and
 * one new top-level PR conversation comment. Repository contents, issues, reviews, branches,
 * merges, edits, and deletes are all outside the standard integration.
 */
export function githubSourcePolicy(tool: string, url: URL, body: unknown): GithubSourcePolicy {
  if (tool !== "github.get" && tool !== "github.post")
    throw new Error("GitHub source only exposes github.get and github.post")
  const verb = tool === "github.post" ? "POST" : "GET"
  const path = url.pathname

  if (verb === "GET") {
    if (listRepos.test(path) && onlyQueryKeys(url, ["page", "per_page"])) return { verb }
    if (
      listPulls.test(path) &&
      onlyQueryKeys(url, ["base", "direction", "head", "page", "per_page", "sort", "state"])
    )
      return { verb }
    if (getPull.test(path) && queryKeys(url).size === 0) return { verb }
    if (listPullFiles.test(path) && onlyQueryKeys(url, ["page", "per_page"])) return { verb }
    const commentsMatch = pullComments.exec(path)
    if (commentsMatch && onlyQueryKeys(url, ["page", "per_page", "since"])) {
      const [, owner, repo, number] = commentsMatch
      return { verb, prPreflightPath: `/repos/${owner}/${repo}/pulls/${number}` }
    }
    throw new Error(
      "GitHub source only permits reading repositories, pull requests, and PR comments",
    )
  }

  const match = pullComments.exec(path)
  if (!match || queryKeys(url).size !== 0)
    throw new Error("GitHub source only permits adding a top-level pull request comment")
  if (!plainObject(body) || Object.keys(body).length !== 1 || typeof body.body !== "string")
    throw new Error("a GitHub pull request comment must contain only a body string")
  const comment = body.body.trim()
  if (!comment || comment.length > 65_536)
    throw new Error("a GitHub pull request comment body must be 1–65,536 characters")
  const [, owner, repo, number] = match
  return { verb, prPreflightPath: `/repos/${owner}/${repo}/pulls/${number}` }
}
