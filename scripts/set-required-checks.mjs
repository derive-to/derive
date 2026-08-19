#!/usr/bin/env node

// Point main's ruleset at the required status checks this repo has decided on
// (scripts/required-checks.mjs), without touching anything else about it.
//
// Branch protection is the one setting that cannot be reviewed in a diff, so this
// exists instead of a one-off curl: it is re-runnable, it is idempotent, it says
// what it will do before it does it, and the next person can read what happened.
//
//   pnpm ci:required-checks            # dry run — prints the diff, changes nothing
//   pnpm ci:required-checks --apply    # writes it
//
// SAFETY, in the order it matters:
//
//   - It REFUSES to require a context that no job on main produces. Requiring a
//     check nothing reports does not fail a PR, it hangs it: the status sits at
//     "Expected — waiting for status to be reported" and the PR can never merge.
//     Doing that to a repository's whole open-PR queue is the expensive mistake
//     here, so the check is not optional and not skippable.
//   - It PATCHES only the required_status_checks rule and carries every other
//     rule through byte-for-byte. Deletion protection, linear history, the pull
//     request rule and the strict-up-to-date policy are not this script's
//     business and it must not be able to drop one by omission.
//   - It prints the previous value so a mistake can be undone by hand.
//
// ORDERING. `gate` has to exist on main BEFORE it is required. On a PR event
// GitHub runs the workflow from the PR's own branch, so a branch that predates
// the lane split produces no `gate` context at all. The ruleset already sets
// strict_required_status_checks_policy, which forces every PR to update onto
// main's head before merging — so once this has landed on main, open PRs pick the
// new lane up through the update they already had to do. Run this AFTER the
// workflow change merges, not before.

import { REQUIRED_CONTEXTS, RULESET_NAME } from "./required-checks.mjs"

const apply = process.argv.includes("--apply")
const repository = process.env.GITHUB_REPOSITORY || "derive-to/derive"
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error(`invalid GITHUB_REPOSITORY: ${repository}`)

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token)
  throw new Error(
    "GITHUB_TOKEN (or GH_TOKEN) is required — try: GITHUB_TOKEN=$(gh auth token) pnpm ci:required-checks",
  )

const api = async (path, init) => {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "derive-set-required-checks",
      "x-github-api-version": "2026-03-10",
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  })
  if (!response.ok)
    throw new Error(
      `GitHub ${init?.method ?? "GET"} ${path} returned ${response.status}: ${await response.text()}`,
    )
  return response.json()
}

// --- the contexts MAIN can actually produce -------------------------------
// Read from the DEFAULT BRANCH over the API, deliberately, not from the working
// tree. The working tree is the wrong question: on a pull_request event GitHub
// runs the workflow from the PR's own branch, so what decides whether a context
// ever gets reported is what has LANDED, not what is checked out here. Reading
// the local file would happily approve `gate` from the very branch that is
// adding it — which is exactly the moment it does not exist yet for anyone else.
// Job ids are the status-check contexts unless a job sets `name:`, which none do.
const defaultBranch = (await api("")).default_branch
const workflowOnDefault = async (path) => {
  try {
    const file = await api(`/contents/${path}?ref=${encodeURIComponent(defaultBranch)}`)
    return Buffer.from(file.content, "base64").toString("utf8")
  } catch {
    return ""
  }
}
const jobsIn = (text) => {
  const at = text.search(/^jobs:$/m)
  if (at === -1) return []
  return [...text.slice(at).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])
}
const produced = new Set(
  (
    await Promise.all([
      workflowOnDefault(".github/workflows/ci.yml"),
      workflowOnDefault(".github/workflows/codeql.yml"),
    ])
  ).flatMap(jobsIn),
)

const missing = REQUIRED_CONTEXTS.filter((c) => !produced.has(c))
if (missing.length) {
  console.error(`refusing to continue: no job on ${defaultBranch} produces ${missing.join(", ")}.`)
  console.error(
    "Requiring a context nothing reports does not fail a PR, it hangs it — every open PR would sit",
  )
  console.error(
    "at \u201cExpected \u2014 waiting for status to be reported\u201d and become unmergeable.",
  )
  console.error(`Land the workflow change on ${defaultBranch} first, then re-run this.`)
  console.error(`jobs on ${defaultBranch}: ${[...produced].sort().join(", ") || "none"}`)
  process.exit(1)
}

// --- read, diff, write ----------------------------------------------------
const summaries = await api("/rulesets")
const summary = summaries.find((r) => r.name === RULESET_NAME)
if (!summary) throw new Error(`no ruleset named ${JSON.stringify(RULESET_NAME)} on ${repository}`)
const ruleset = await api(`/rulesets/${summary.id}`)

const statusRule = ruleset.rules.find((r) => r.type === "required_status_checks")
if (!statusRule) throw new Error(`ruleset ${summary.id} has no required_status_checks rule`)

const before = statusRule.parameters.required_status_checks.map((c) => c.context).sort()
const after = [...REQUIRED_CONTEXTS].sort()
console.log(`ruleset  : ${ruleset.name} (#${summary.id}, ${ruleset.enforcement})`)
console.log(`before   : ${before.join(", ") || "none"}`)
console.log(`after    : ${after.join(", ")}`)
console.log(`strict   : ${statusRule.parameters.strict_required_status_checks_policy} (unchanged)`)

if (JSON.stringify(before) === JSON.stringify(after)) {
  console.log("\nalready correct — nothing to do.")
  process.exit(0)
}
if (!apply) {
  console.log("\ndry run. Re-run with --apply to write this.")
  process.exit(0)
}

// Carry every other rule through untouched; replace only this one's contexts.
const rules = ruleset.rules.map((rule) =>
  rule.type === "required_status_checks"
    ? {
        ...rule,
        parameters: {
          ...rule.parameters,
          required_status_checks: REQUIRED_CONTEXTS.map((context) => ({ context })),
        },
      }
    : rule,
)

await api(`/rulesets/${summary.id}`, { method: "PUT", body: JSON.stringify({ rules }) })

const confirmed = await api(`/rulesets/${summary.id}`)
const now = confirmed.rules
  .find((r) => r.type === "required_status_checks")
  .parameters.required_status_checks.map((c) => c.context)
  .sort()
if (JSON.stringify(now) !== JSON.stringify(after))
  throw new Error(`write did not stick: ruleset now requires ${now.join(", ")}`)

const kept = confirmed.rules.map((r) => r.type).sort()
console.log(`\napplied. now requires: ${now.join(", ")}`)
console.log(`rules intact: ${kept.join(", ")}`)
console.log(`previous value, to undo by hand: ${before.join(", ")}`)
