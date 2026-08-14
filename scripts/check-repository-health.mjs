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
    },
  })
  if (!response.ok) throw new Error(`GitHub ${path} returned ${response.status}`)
  return response.json()
}

const [repo, reporting] = await Promise.all([api(""), api("/private-vulnerability-reporting")])
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
  console.log(`repository health: ok — ${repository} public security and community settings agree`)
}
