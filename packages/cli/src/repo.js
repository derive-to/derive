// A task's repository on a Derive machine: checked out before the harness starts, reached with
// the task's short-lived GitHub token, and read back after the turn for the pull request it
// opened. The token lives in a private file the runner keeps fresh (on tmpfs on a Derive
// machine): git asks a credential helper that reads it there, so nothing secret lands in the
// checkout the machine's disk keeps.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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

/** `gh` reads its token only from GH_TOKEN, which a running harness would keep from the first
 *  hour. A `gh` placed first on PATH beside the token file reads the renewed token on every
 *  call instead. Nothing when the machine has no `gh`. */
function ghThroughFile(tokenFile) {
  const real = spawnSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).stdout.trim()
  if (!real) return {}
  const bin = join(dirname(tokenFile), "bin")
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nGH_TOKEN="$(cat "$DERIVE_GIT_TOKEN_FILE")" exec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o700 },
  )
  return { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }
}

/** Check out the task's repository and return where, plus the environment git and the harness
 *  need. A checkout of the same repository already on the machine (a prepared image's, or an
 *  earlier turn's) is reused; only the first turn moves it to the task's ref, so later turns
 *  keep the work in progress.
 *
 *  With `task`, on a machine many tasks share (a team's own box), the shared checkout only
 *  holds the objects: each task works in its own git worktree beside it, made on the task's
 *  first turn and kept for its follow-ups, so parallel tasks never touch each other's files. */
export function prepareRepo({ repo, ref, token }, { cwd, firstTurn, tokenFile, task }) {
  writeFileSync(tokenFile, token, { mode: 0o600 })
  const env = { DERIVE_GIT_TOKEN_FILE: tokenFile, ...ghThroughFile(tokenFile) }
  const name = repo.split("/")[1]
  const mine = (dir) =>
    existsSync(join(dir, ".git")) &&
    githubRepoOf(
      run(["config", "--get", "remote.origin.url"], { cwd: dir, quiet: true }).stdout.trim(),
    ) === repo.toLowerCase()
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
  const start = () => {
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
    return branch.status === 0 ? { base, at: `origin/${base}` } : { base, at: base }
  }
  if (task) {
    const tasks = join(cwd, ".derive-tasks")
    const own = join(tasks, task)
    if (!existsSync(own)) {
      mkdirSync(tasks, { recursive: true })
      retireOldWorktrees(dir, tasks)
      run(["worktree", "add", "--detach", own, start().at], { cwd: dir, env })
    }
    return { dir: own, env }
  }
  if (firstTurn) {
    const { base, at } = start()
    if (at === `origin/${base}`) run(["checkout", "--force", "-B", base, at], { cwd: dir })
    else run(["checkout", "--force", "--detach", base], { cwd: dir, env })
  }
  return { dir, env }
}

/** Task worktrees untouched for a week go, as parked cloud machines do. */
const WORKTREE_TTL_MS = 7 * 24 * 3600_000
function retireOldWorktrees(dir, tasks) {
  for (const entry of readdirSync(tasks, { withFileTypes: true })) {
    const path = join(tasks, entry.name)
    if (entry.isDirectory() && Date.now() - statSync(path).mtimeMs > WORKTREE_TTL_MS)
      run(["worktree", "remove", "--force", path], { cwd: dir, quiet: true })
  }
  run(["worktree", "prune"], { cwd: dir, quiet: true })
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
