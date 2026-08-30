const REPO_PART = "[A-Za-z0-9_.-]+"
const NUMBER = "[1-9][0-9]*"
const WORKFLOW = `(?:${NUMBER}|[A-Za-z0-9_.-]+\\.ya?ml)`

const listRepos = /^\/installation\/repositories$/
const listPulls = new RegExp(`^/repos/${REPO_PART}/${REPO_PART}/pulls$`)
const getPull = new RegExp(`^/repos/${REPO_PART}/${REPO_PART}/pulls/${NUMBER}$`)
const listPullFiles = new RegExp(`^/repos/${REPO_PART}/${REPO_PART}/pulls/${NUMBER}/files$`)
const pullComments = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/issues/(${NUMBER})/comments$`,
)
const listWorkflows = new RegExp(`^/repos/(${REPO_PART})/(${REPO_PART})/actions/workflows$`)
const getWorkflow = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/workflows/(${WORKFLOW})$`,
)
const workflowRuns = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/workflows/(${WORKFLOW})/runs$`,
)
const dispatchWorkflow = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/workflows/(${WORKFLOW})/dispatches$`,
)
const getRun = new RegExp(`^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})$`)
const runJobs = new RegExp(`^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})/jobs$`)
const runArtifacts = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})/artifacts$`,
)
const cancelRun = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})/cancel$`,
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
  /** The permission-narrowed installation token this operation needs. */
  tokenProfile: "standard-pr" | "workflow-dispatch"
  /** Actions tokens are narrowed to this one repository at mint time. */
  repository?: string
  /** Workflow dispatch returns the run id under the current GitHub API version. */
  apiVersion?: string
}

const standardPr = (extra: Omit<GithubSourcePolicy, "tokenProfile">): GithubSourcePolicy => ({
  tokenProfile: "standard-pr",
  ...extra,
})

const workflowAction = (
  repository: string,
  extra: Omit<GithubSourcePolicy, "repository" | "tokenProfile">,
): GithubSourcePolicy => ({ repository, tokenProfile: "workflow-dispatch", ...extra })

const workflowInputsAreValid = (value: unknown): boolean => {
  if (value === undefined) return true
  if (!plainObject(value) || Object.keys(value).length > 25) return false
  return Object.entries(value).every(
    ([key, input]) =>
      /^[A-Za-z0-9_-]{1,100}$/.test(key) &&
      (typeof input === "string" || typeof input === "number" || typeof input === "boolean"),
  )
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
    if (listRepos.test(path) && onlyQueryKeys(url, ["page", "per_page"]))
      return standardPr({ verb })
    if (
      listPulls.test(path) &&
      onlyQueryKeys(url, ["base", "direction", "head", "page", "per_page", "sort", "state"])
    )
      return standardPr({ verb })
    if (getPull.test(path) && queryKeys(url).size === 0) return standardPr({ verb })
    if (listPullFiles.test(path) && onlyQueryKeys(url, ["page", "per_page"]))
      return standardPr({ verb })
    const commentsMatch = pullComments.exec(path)
    if (commentsMatch && onlyQueryKeys(url, ["page", "per_page", "since"])) {
      const [, owner, repo, number] = commentsMatch
      return standardPr({ verb, prPreflightPath: `/repos/${owner}/${repo}/pulls/${number}` })
    }
    const workflowsMatch = listWorkflows.exec(path)
    if (workflowsMatch && onlyQueryKeys(url, ["page", "per_page"]))
      return workflowAction(workflowsMatch[2] as string, { verb })
    const workflowMatch = getWorkflow.exec(path)
    if (workflowMatch && queryKeys(url).size === 0)
      return workflowAction(workflowMatch[2] as string, { verb })
    const workflowRunsMatch = workflowRuns.exec(path)
    if (
      workflowRunsMatch &&
      onlyQueryKeys(url, [
        "actor",
        "branch",
        "check_suite_id",
        "created",
        "event",
        "exclude_pull_requests",
        "head_sha",
        "page",
        "per_page",
        "status",
      ])
    )
      return workflowAction(workflowRunsMatch[2] as string, { verb })
    const runMatch = getRun.exec(path)
    if (runMatch && queryKeys(url).size === 0)
      return workflowAction(runMatch[2] as string, { verb })
    const jobsMatch = runJobs.exec(path)
    if (jobsMatch && onlyQueryKeys(url, ["filter", "page", "per_page"]))
      return workflowAction(jobsMatch[2] as string, { verb })
    const artifactsMatch = runArtifacts.exec(path)
    if (artifactsMatch && onlyQueryKeys(url, ["name", "page", "per_page"]))
      return workflowAction(artifactsMatch[2] as string, { verb })
    throw new Error(
      "GitHub source only permits reading repositories, pull requests, PR comments, and workflow runs",
    )
  }

  const dispatchMatch = dispatchWorkflow.exec(path)
  if (dispatchMatch && queryKeys(url).size === 0) {
    if (
      !plainObject(body) ||
      Object.keys(body).some((key) => key !== "ref" && key !== "inputs") ||
      typeof body.ref !== "string" ||
      !body.ref.trim() ||
      body.ref.length > 1_024 ||
      !workflowInputsAreValid(body.inputs)
    )
      throw new Error("a GitHub workflow dispatch must contain a ref and at most 25 scalar inputs")
    return workflowAction(dispatchMatch[2] as string, {
      apiVersion: "2026-03-10",
      verb,
    })
  }

  const cancelMatch = cancelRun.exec(path)
  if (
    cancelMatch &&
    queryKeys(url).size === 0 &&
    (body === undefined || (plainObject(body) && Object.keys(body).length === 0))
  )
    return workflowAction(cancelMatch[2] as string, { verb })

  const match = pullComments.exec(path)
  if (!match || queryKeys(url).size !== 0)
    throw new Error("GitHub source only permits adding a top-level pull request comment")
  if (!plainObject(body) || Object.keys(body).length !== 1 || typeof body.body !== "string")
    throw new Error("a GitHub pull request comment must contain only a body string")
  const comment = body.body.trim()
  if (!comment || comment.length > 65_536)
    throw new Error("a GitHub pull request comment body must be 1–65,536 characters")
  const [, owner, repo, number] = match
  return standardPr({ verb, prPreflightPath: `/repos/${owner}/${repo}/pulls/${number}` })
}
