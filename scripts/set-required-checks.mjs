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

// --- the contexts MAIN has actually produced ---------------------------------
// Asked of GitHub, not inferred from the workflow YAML. An earlier version of
// this regex-scraped job ids out of ci.yml and codeql.yml, which is a YAML parser
// written in regex and answers the wrong question besides: what matters is not
// whether a job is DECLARED on main, but whether main has ever REPORTED that
// check. A job can exist and still never produce a context — if it is skipped by
// a path filter, or the workflow errors before it runs.
//
// This matters because the failure mode is expensive. Requiring a context nothing
// reports does not fail a pull request, it HANGS it at "Expected — waiting for
// status to be reported", and with a queue of open PRs that is a repository-wide
// outage rather than one red check.
const defaultBranch = (await api("")).default_branch
const head = (await api(`/commits/${encodeURIComponent(defaultBranch)}`)).sha
const { check_runs: runs } = await api(`/commits/${head}/check-runs?per_page=100&filter=latest`)
const produced = new Set(runs.map((run) => run.name))

const missing = REQUIRED_CONTEXTS.filter((c) => !produced.has(c))
if (missing.length) {
  console.error(
    `refusing to continue: ${defaultBranch} (${head.slice(0, 8)}) has not reported ${missing.join(", ")}.`,
  )
  console.error(
    "Requiring a context nothing reports does not fail a PR, it hangs it — every open PR would sit",
  )
  console.error(
    "at \u201cExpected \u2014 waiting for status to be reported\u201d and become unmergeable.",
  )
  console.error(`Land the workflow change on ${defaultBranch} first, let it run, then re-run this.`)
  console.error(`reported on ${head.slice(0, 8)}: ${[...produced].sort().join(", ") || "none"}`)
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
