// A task's repository on a Derive machine: checked out before the harness starts, reached with
// the task's short-lived GitHub token, and read back after the turn for the pull request it
// opened. The token lives in a private file the runner keeps fresh (on tmpfs on a Derive
// machine): git asks a credential helper that reads it there, so nothing secret lands in the
// checkout the machine's disk keeps.
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$(cat "$DERIVE_GIT_TOKEN_FILE")"; }; f'

const run = (args, { cwd, env, quiet } = {}) => {
  const out = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: 15 * 60_000,
  })
  if (out.status !== 0 && !quiet)
    throw Object.assign(
      new Error(`git ${args[0]} failed: ${(out.stderr || out.stdout).trim().slice(-500)}`),
      {
        retryable: false,
      },
    )
  return out
}

/** `owner/name` from any GitHub remote URL form, lowercased; null for anything else. */
export const githubRepoOf = (url) =>
  /github\.com[/:]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url ?? "")?.[1]?.toLowerCase() ?? null

/** Check out the task's repository and return where, plus the environment git and the harness
 *  need. A checkout of the same repository already on the machine (a prepared image's, or an
 *  earlier turn's) is reused; only the first turn moves it to the task's ref, so later turns
 *  keep the work in progress. */
export function prepareRepo({ repo, ref, token }, { cwd, firstTurn, tokenFile }) {
  writeFileSync(tokenFile, token, { mode: 0o600 })
  const env = { DERIVE_GIT_TOKEN_FILE: tokenFile, GH_TOKEN: token }
  const name = repo.split("/")[1]
  const mine = (dir) =>
    existsSync(join(dir, ".git")) &&
    githubRepoOf(run(["remote", "get-url", "origin"], { cwd: dir, quiet: true }).stdout.trim()) ===
      repo.toLowerCase()
  let dir = [join(cwd, name), join(homedir(), name)].find(mine)
  if (!dir) {
    dir = join(cwd, name)
    run(
      [
        "-c",
        `credential.helper=${HELPER}`,
        "clone",
        "--filter=blob:none",
        `https://github.com/${repo}.git`,
        dir,
      ],
      { env },
    )
  }
  run(["config", "--replace-all", "credential.helper", HELPER], { cwd: dir })
  run(["fetch", "--prune", "origin"], { cwd: dir, env })
  if (firstTurn) {
    const base =
      ref ??
      run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir, quiet: true })
        .stdout.trim()
        .replace(/^origin\//, "")
    if (!base) throw Object.assign(new Error(`${repo} has no default branch`), { retryable: false })
    const branch = run(["rev-parse", "--verify", "--quiet", `origin/${base}`], {
      cwd: dir,
      quiet: true,
    })
    if (branch.status === 0)
      run(["checkout", "--force", "-B", base, `origin/${base}`], { cwd: dir })
    else run(["checkout", "--force", "--detach", base], { cwd: dir, env })
  }
  return { dir, env }
}

/** The pull request the turn's branch has open (or had), for the task's result. */
export async function pullRequestFor({ repo, token }, dir, fetcher = fetch) {
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, quiet: true }).stdout.trim()
  if (!branch || branch === "HEAD") return null
  const [owner] = repo.split("/")
  const res = await fetcher(
    `https://api.github.com/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
  ).catch(() => null)
  const [pr] = res?.ok ? await res.json() : []
  return pr ? { kind: "pr", label: pr.title, ref: `${repo}#${pr.number}`, url: pr.html_url } : null
}
