#!/usr/bin/env node

// Public GitHub settings do not live in Git, so a green checkout cannot prove
// that the community-facing security path still works. This networked audit is
// intentionally NOT part of `pnpm verify`; the scheduled workflow runs it against
// GitHub itself, and maintainers can run `pnpm audit:repository` on demand.

import { readFileSync } from "node:fs"

const repository = process.env.GITHUB_REPOSITORY || "derive-to/derive"
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error(`invalid GITHUB_REPOSITORY: ${repository}`)

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "derive-repository-health",
      "x-github-api-version": "2026-03-10",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`GitHub ${path} returned ${response.status}`)
  return response.json()
}

const [repo, reporting, ruleSummaries] = await Promise.all([
  api(""),
  api("/private-vulnerability-reporting"),
  api("/rulesets"),
])
const rulesets = await Promise.all(ruleSummaries.map((ruleset) => api(`/rulesets/${ruleset.id}`)))
const failures = []
const requireState = (condition, message) => {
  if (!condition) failures.push(message)
}

requireState(repo.visibility === "public", "repository is not public")
requireState(repo.archived === false, "repository is archived")
requireState(repo.default_branch === "main", "default branch is not main")
requireState(repo.has_issues === true, "issues are disabled")
requireState(repo.has_discussions === true, "discussions are disabled")
requireState(repo.has_wiki === false, "the unused GitHub wiki is enabled")
requireState(repo.homepage === "https://derive.to", "repository homepage is not https://derive.to")
requireState(
  typeof repo.description === "string" && repo.description.length > 20,
  "description is missing",
)
for (const topic of ["fair-source", "mcp-server", "self-hosted"])
  requireState(repo.topics?.includes(topic), `required topic is missing: ${topic}`)
requireState(reporting.enabled === true, "private vulnerability reporting is disabled")

const mainRulesets = rulesets.filter(
  (ruleset) =>
    ruleset.enforcement === "active" &&
    ruleset.target === "branch" &&
    ruleset.conditions?.ref_name?.include?.includes("refs/heads/main"),
)
requireState(mainRulesets.length === 1, "main must have exactly one active branch ruleset")
const mainRuleset = mainRulesets[0]
const rule = (type) => mainRuleset?.rules?.find((candidate) => candidate.type === type)
requireState(mainRuleset?.bypass_actors?.length === 0, "main ruleset has bypass actors")
requireState(!!rule("deletion"), "main ruleset does not prevent deletion")
requireState(!!rule("non_fast_forward"), "main ruleset does not prevent force pushes")
requireState(!!rule("required_linear_history"), "main ruleset does not require linear history")

const pullRequest = rule("pull_request")?.parameters
requireState(
  (pullRequest?.required_approving_review_count ?? 0) >= 1,
  "main ruleset does not require an approving review",
)
requireState(pullRequest?.require_code_owner_review === true, "code-owner review is not required")
requireState(
  pullRequest?.dismiss_stale_reviews_on_push === true,
  "stale reviews are not dismissed on push",
)
requireState(
  pullRequest?.require_last_push_approval === true,
  "the last push does not require independent approval",
)
requireState(
  pullRequest?.required_review_thread_resolution === true,
  "review-thread resolution is not required",
)

const statuses = rule("required_status_checks")?.parameters
const actualContexts = (statuses?.required_status_checks ?? [])
  .map((status) => status.context)
  .sort()
const requiredContexts = ["accessibility", "analyze", "check", "db"]
requireState(
  statuses?.strict_required_status_checks_policy === true,
  "required checks are not strict",
)
requireState(
  JSON.stringify(actualContexts) === JSON.stringify(requiredContexts),
  `main required checks differ: ${actualContexts.join(", ") || "none"}`,
)

const advisoryPath = `https://github.com/${repository}/security/advisories/new`
for (const file of ["SECURITY.md", ".github/ISSUE_TEMPLATE/config.yml"])
  requireState(
    readFileSync(file, "utf8").includes(advisoryPath),
    `${file} does not link to ${advisoryPath}`,
  )

if (failures.length) {
  for (const failure of failures) console.error(`repository health: ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `repository health: ok — ${repository} public security, community, and main ruleset settings agree`,
  )
}
