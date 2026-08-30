import type { GitHubTokenProfile } from "./github-app"

// Bound every attacker-controlled path component before token minting. GitHub names are much
// shorter than these limits, but the explicit ceiling also prevents cache-key and URL abuse.
const REPO_PART = "[A-Za-z0-9_.-]{1,100}"
const NUMBER = "[1-9][0-9]{0,19}"
const WORKFLOW_FILE = "[A-Za-z0-9_.-]{1,200}\\.ya?ml"
const WORKFLOW = `(?:${NUMBER}|${WORKFLOW_FILE})`
// Dispatch is opt-in by filename. Existing release and deployment workflows stay unreachable
// unless their owner deliberately exposes a Derive adapter workflow.
const DERIVE_WORKFLOW = "derive-[A-Za-z0-9_.-]{1,193}\\.ya?ml"

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
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/workflows/(${DERIVE_WORKFLOW})/dispatches$`,
)
const anyWorkflowDispatch = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/workflows/(${WORKFLOW})/dispatches$`,
)
const getRun = new RegExp(`^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})$`)
const runJobs = new RegExp(`^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})/jobs$`)
const runArtifacts = new RegExp(
  `^/repos/(${REPO_PART})/(${REPO_PART})/actions/runs/(${NUMBER})/artifacts$`,
)
const queryKeys = (url: URL): Set<string> => new Set(url.searchParams.keys())
const onlyQueryKeys = (url: URL, allowed: readonly string[]): boolean => {
  const allowedSet = new Set(allowed)
  const entries = [...url.searchParams.entries()]
  if (
    entries.length !== queryKeys(url).size ||
    entries.some(([key, value]) => !allowedSet.has(key) || value.length > 256)
  )
    return false
  const page = url.searchParams.get("page")
  const perPage = url.searchParams.get("per_page")
  return (
    (!page || /^[1-9][0-9]{0,5}$/.test(page)) &&
    (!perPage || /^(?:[1-9]|[1-9][0-9]|100)$/.test(perPage))
  )
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

export interface GithubSourcePolicy {
  /** The only HTTP verbs the frozen direct-tool surface can advertise. */
  verb: "GET" | "POST"
  /** For comment writes, the PR endpoint used to prove the issue number is a PR. */
  prPreflightPath?: string
  /** The permission-narrowed installation token this operation needs. */
  tokenProfile: GitHubTokenProfile
  /** Actions tokens are narrowed to this one repository at mint time. */
  repository?: string
  /** Workflow dispatch returns the run id under the current GitHub API version. */
  apiVersion?: string
}

const standardRead = (extra: Omit<GithubSourcePolicy, "tokenProfile">): GithubSourcePolicy => ({
  tokenProfile: "standard-read",
  ...extra,
})

const prComment = (extra: Omit<GithubSourcePolicy, "tokenProfile">): GithubSourcePolicy => ({
  tokenProfile: "pr-comment",
  ...extra,
})

const workflowAction = (
  repository: string,
  extra: Omit<GithubSourcePolicy, "repository">,
): GithubSourcePolicy => ({ apiVersion: "2026-03-10", repository, ...extra })

const workflowInputsAreValid = (value: unknown): boolean => {
  if (value === undefined) return true
  if (!plainObject(value) || Object.keys(value).length > 25) return false
  const entriesAreValid = Object.entries(value).every(([key, input]) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) return false
    if (typeof input === "number") return Number.isFinite(input)
    return typeof input === "string" || typeof input === "boolean"
  })
  // GitHub documents this as characters, not bytes. JSON is the exact payload representation
  // and includes keys, quotes, and separators, so this refuses before GitHub's 65,535 limit.
  return entriesAreValid && JSON.stringify(value).length <= 65_535
}

const workflowRefIsValid = (value: unknown): value is string => {
  if (typeof value !== "string" || !value || value.length > 1_024 || value !== value.trim())
    return false
  const forbiddenCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character)
  })
  if (
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    forbiddenCharacter
  )
    return false
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
}

/**
 * The effective GitHub source boundary. The App permission must be write-level to create a
 * PR conversation comment, but that vendor scope is broader than the product contract. This
 * policy is therefore checked before token minting and before any network request.
 *
 * Keep this list deliberately small: PR discovery/detail/files, PR conversation reads, one new
 * top-level PR conversation comment, Actions reads, and dispatch of explicitly opted-in
 * `derive-*.yml` workflows. Repository contents, issues, reviews, branches, merges, edits,
 * deletes, reruns, and cancellation of unproven runs are all outside the standard integration.
 */
export function githubSourcePolicy(tool: string, url: URL, body: unknown): GithubSourcePolicy {
  if (tool !== "github.get" && tool !== "github.post")
    throw new Error("GitHub source only exposes github.get and github.post")
  const verb = tool === "github.post" ? "POST" : "GET"
  const path = url.pathname

  if (verb === "GET") {
    if (listRepos.test(path) && onlyQueryKeys(url, ["page", "per_page"]))
      return standardRead({ verb })
    if (
      listPulls.test(path) &&
      onlyQueryKeys(url, ["base", "direction", "head", "page", "per_page", "sort", "state"])
    )
      return standardRead({ verb })
    if (getPull.test(path) && queryKeys(url).size === 0) return standardRead({ verb })
    if (listPullFiles.test(path) && onlyQueryKeys(url, ["page", "per_page"]))
      return standardRead({ verb })
    const commentsMatch = pullComments.exec(path)
    if (commentsMatch && onlyQueryKeys(url, ["page", "per_page", "since"])) {
      const [, owner, repo, number] = commentsMatch
      return standardRead({ verb, prPreflightPath: `/repos/${owner}/${repo}/pulls/${number}` })
    }
    const workflowsMatch = listWorkflows.exec(path)
    if (workflowsMatch && onlyQueryKeys(url, ["page", "per_page"]))
      return workflowAction(workflowsMatch[2] as string, { verb, tokenProfile: "workflow-read" })
    const workflowMatch = getWorkflow.exec(path)
    if (workflowMatch && queryKeys(url).size === 0)
      return workflowAction(workflowMatch[2] as string, { verb, tokenProfile: "workflow-read" })
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
      return workflowAction(workflowRunsMatch[2] as string, {
        verb,
        tokenProfile: "workflow-read",
      })
    const runMatch = getRun.exec(path)
    if (runMatch && queryKeys(url).size === 0)
      return workflowAction(runMatch[2] as string, { verb, tokenProfile: "workflow-read" })
    const jobsMatch = runJobs.exec(path)
    if (jobsMatch && onlyQueryKeys(url, ["filter", "page", "per_page"]))
      return workflowAction(jobsMatch[2] as string, { verb, tokenProfile: "workflow-read" })
    const artifactsMatch = runArtifacts.exec(path)
    if (artifactsMatch && onlyQueryKeys(url, ["name", "page", "per_page"]))
      return workflowAction(artifactsMatch[2] as string, {
        verb,
        tokenProfile: "workflow-read",
      })
    throw new Error(
      "GitHub source only permits reading repositories, pull requests, PR comments, and workflow runs",
    )
  }

  const dispatchMatch = dispatchWorkflow.exec(path)
  if (dispatchMatch && queryKeys(url).size === 0) {
    if (
      !plainObject(body) ||
      Object.keys(body).some((key) => key !== "ref" && key !== "inputs") ||
      !workflowRefIsValid(body.ref) ||
      !workflowInputsAreValid(body.inputs)
    )
      throw new Error(
        "a GitHub workflow dispatch needs a valid ref and at most 25 scalar inputs (65,535 characters total)",
      )
    return workflowAction(dispatchMatch[2] as string, {
      tokenProfile: "workflow-dispatch",
      verb,
    })
  }
  if (anyWorkflowDispatch.test(path))
    throw new Error("GitHub dispatch only permits adapter workflows named derive-*.yml")

  const match = pullComments.exec(path)
  if (!match || queryKeys(url).size !== 0)
    throw new Error("GitHub source only permits adding a top-level pull request comment")
  if (!plainObject(body) || Object.keys(body).length !== 1 || typeof body.body !== "string")
    throw new Error("a GitHub pull request comment must contain only a body string")
  const comment = body.body.trim()
  if (!comment || comment.length > 65_536)
    throw new Error("a GitHub pull request comment body must be 1–65,536 characters")
  const [, owner, repo, number] = match
  return prComment({ verb, prPreflightPath: `/repos/${owner}/${repo}/pulls/${number}` })
}
