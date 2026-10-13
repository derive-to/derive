// Cloud sessions from the terminal: start, list, attach to, forward from, and stop tasks that
// run on Derive machines. Every session is an ordinary Derive task, so the web app shows the
// same list; this file only drives the API and hands the terminal to ssh.
//
//   derive code [owner/name[@ref]] ["first message"] [--agent a] [--codex|--claude] [--here]
//   derive run <agent> "ask" [--repo owner/name[@ref]] [--here] [--follow]
//   derive ls [--team]
//   derive attach <task>      derive forward <task> <port>      derive stop <task>
//   derive send <task> "msg" [--interrupt]   derive follow <task>   derive show <task>
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { SESSION_RESUME, SESSION_TMUX, TASK_REPO } from "./conversation-format.js"
import { githubRepoOf } from "./repo.js"
import { DeriveClient } from "./runner.js"

const KEY_DIR = () => process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".derive")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The session commands' client: the CLI's Derive client, reporting refusals in the
 *  server's own words. */
export function sessionApi({ server, token, workspaceId, fetcher }) {
  const client = new DeriveClient(server, token, { workspaceId, fetcher })
  return (path, { method = "GET", body } = {}) =>
    client
      .call(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      .catch((error) => {
        throw Object.assign(new Error(error.reason ?? error.message), { status: error.status })
      })
}

/** The agent new work runs on: `--agent` by id or name, else the workspace's agent named
 *  "Coding", else the only cloud agent for the chosen harness. A session needs a Derive
 *  machine; a task may also run on a team's own box. */
export function pickAgent(agents, { agent, harness, boxes = false } = {}) {
  const cloud = agents.filter((a) => a.machine === "derive" || (boxes && a.machine === "owner"))
  if (agent) {
    const want = String(agent).toLowerCase()
    const found = cloud.find((a) => a.id === agent || a.name.toLowerCase() === want)
    if (!found) throw new Error(`no cloud agent "${agent}". Cloud agents: ${names(cloud)}`)
    return found
  }
  const fits = harness ? cloud.filter((a) => a.provider === harness) : cloud
  const coding = fits.find((a) => a.name.toLowerCase() === "coding")
  if (coding) return coding
  if (fits.length === 1) return fits[0]
  throw new Error(
    fits.length
      ? `pick an agent with --agent: ${names(fits)}`
      : "no cloud agent yet. Create one in Derive (Agents → New, machine: Derive).",
  )
}
const names = (agents) => agents.map((a) => a.name).join(", ") || "none"

/** A task by full id or a unique suffix of one, from the list `derive ls` shows. */
export function pickTask(tasks, ref) {
  if (!ref) throw new Error("name a task: derive ls shows them")
  const hits = tasks.filter((t) => t.id === ref || t.id.endsWith(ref))
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length ? `"${ref}" matches several tasks` : `no task "${ref}"`)
}

/** One line per cloud task: id, agent, harness, repository, and where it stands. */
export function formatTasks(tasks, agents) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = tasks.map((t) => {
    const agent = byId.get(t.agent_id)
    return [
      t.id.slice(-6),
      agent?.name ?? "?",
      agent?.provider === "codex" ? "codex" : "claude",
      t.task?.session ? "session" : t.trigger_id ? "scheduled" : "task",
      t.task?.repo ?? "-",
      state(t),
      ago(t.updated_at),
    ]
  })
  const head = ["id", "agent", "harness", "kind", "repo", "state", "last"]
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r) =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd()
  return [line(head), ...rows.map(line)].join("\n")
}

const state = (t) => {
  if (
    ["succeeded", "failed", "cancelled", "lost"].includes(t.status) &&
    t.machine_phase !== "parked"
  )
    return t.status
  if (t.status === "needs_you") return "needs you"
  if (t.machine_phase === "parked") return "paused"
  if (t.machine_waiting) return "waiting (provider start limit)"
  if (["creating", "provisioning", "starting", "ready", "launching"].includes(t.machine_phase))
    return "starting"
  if (t.machine_phase === "running") return "working"
  return t.status
}
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

/** Cloud tasks for `derive ls`: yours (and your agents'), or the whole workspace's. */
async function cloudTasks(api, { team }) {
  const [{ jobs }, { agents }] = await Promise.all([
    api(`/v1/jobs?limit=100${team ? "" : "&mine=1"}`),
    api("/v1/agents"),
  ])
  // Work on Derive machines and on a team's own boxes alike.
  const cloud = new Set(
    agents.filter((a) => a.machine === "derive" || a.machine === "owner").map((a) => a.id),
  )
  return { tasks: jobs.filter((j) => cloud.has(j.agent_id)), agents }
}

/** `--here`: the checkout this terminal is in, as the task's repository at its current branch.
 *  The branch is pushed first so the cloud machine starts from exactly these commits; work not
 *  yet committed stays here, and the command says so rather than guessing what to do with it. */
export function hereRepo(cwd = process.cwd(), git = gitIn) {
  const repo = githubRepoOf(git(cwd, ["remote", "get-url", "origin"]))
  if (!repo) throw new Error("--here needs a checkout whose origin is on GitHub")
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (!branch || branch === "HEAD") throw new Error("--here needs a branch, not a detached HEAD")
  if (git(cwd, ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("commit your changes first: --here hands over the branch as pushed")
  git(cwd, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`])
  return `${repo}@${branch}`
}
const gitIn = (cwd, args) => {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (out.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(out.stderr || out.stdout).trim().slice(-300)}`)
  return out.stdout.trim()
}

/** This machine's session key, made once. Only its public half ever leaves the laptop. */
function sessionKey() {
  const dir = KEY_DIR()
  const key = join(dir, "session_ed25519")
  if (!existsSync(key)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const made = spawnSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "derive-session",
      "-f",
      key,
    ])
    if (made.status !== 0) throw new Error("could not create an SSH key (is ssh-keygen installed?)")
  }
  return { key, publicKey: readFileSync(`${key}.pub`, "utf8").trim() }
}

/** Wait for a task's machine to be running, resuming a paused session first. */
async function ensureRunning(api, id, log) {
  let task = await api(`/v1/jobs/${id}`)
  if (task.machine_phase !== "running" && !["queued", "running"].includes(task.status)) {
    log("resuming the session…")
    task = await api(`/v1/jobs/${id}/messages`, {
      method: "POST",
      body: { body_md: SESSION_RESUME },
    })
  }
  for (let i = 0; i < 90 && task.machine_phase !== "running"; i++) {
    if (["failed", "cancelled", "lost"].includes(task.status))
      throw new Error(`the task ${task.status}: ${task.result?.failure?.message ?? "see Derive"}`)
    if (i % 5 === 0) log(`waiting for the machine (${state(task)})…`)
    await sleep(2_000)
    task = await api(`/v1/jobs/${id}`)
  }
  if (task.machine_phase !== "running") throw new Error("the machine did not come up in 3 minutes")
  return task
}

/** Authorize this laptop's key on the task's machine and pin its host key. */
async function openShell(api, id) {
  const { key, publicKey } = sessionKey()
  const at = await api(`/v1/jobs/${id}/attach`, { method: "POST", body: { public_key: publicKey } })
  const knownHosts = join(KEY_DIR(), "known_hosts")
  if (at.host_key)
    writeFileSync(knownHosts, `[${at.host}]:${at.port} ${at.host_key}\n`, { mode: 0o600 })
  return {
    tmux: at.tmux_session ?? SESSION_TMUX,
    ssh: [
      "-i",
      key,
      "-p",
      String(at.port),
      "-o",
      at.host_key ? `UserKnownHostsFile=${knownHosts}` : "StrictHostKeyChecking=accept-new",
      ...(at.host_key ? ["-o", "StrictHostKeyChecking=yes"] : []),
      "-o",
      "ServerAliveInterval=30",
      `${at.user}@${at.host}`,
    ],
  }
}

/** Run one session command. Returns the process exit code. */
export async function sessionCommand(cmd, positional, flags, api, { log = console.error } = {}) {
  const harness = flags.codex ? "codex" : flags.claude ? "claude-code" : undefined
  if (cmd === "code" || cmd === "run") {
    const { agents } = await api("/v1/agents")
    const session = cmd === "code"
    const agent = session
      ? pickAgent(agents, { agent: flags.agent, harness })
      : pickAgent(agents, { agent: positional[0], boxes: true })
    // `derive code owner/name "message"`, `derive code owner/name`, or `derive code "message"`.
    const named = session && TASK_REPO.test(positional[0] ?? "")
    const repo = flags.here ? hereRepo() : named ? positional[0] : flags.repo
    const ask = session ? positional[named ? 1 : 0] : positional[1]
    if (!session && !ask) throw new Error('usage: derive run <agent> "what to do"')
    const task = await api("/v1/jobs", {
      method: "POST",
      body: {
        agent_id: agent.id,
        instruction: ask ?? "Interactive session",
        ...(session ? { session: true } : {}),
        ...(repo ? { repo } : {}),
      },
    })
    log(
      `${session ? "session" : "task"} ${task.id.slice(-6)} on ${agent.name}${repo ? ` · ${repo}` : ""}`,
    )
    if (session) return attach(api, task.id, log)
    console.log(task.id)
    if (!flags.follow) return 0
    return follow(api, task.id, log)
  }
  if (cmd === "ls") {
    const { tasks, agents } = await cloudTasks(api, { team: !!flags.team })
    if (flags.json) console.log(JSON.stringify(tasks))
    else console.log(tasks.length ? formatTasks(tasks, agents) : "no cloud tasks yet: derive code")
    return 0
  }
  const { tasks, agents } = await cloudTasks(api, { team: true })
  const task = pickTask(tasks, positional[0])
  if (cmd === "attach") return attach(api, task.id, log)
  if (cmd === "send") {
    const body = positional[1]
    if (!body) throw new Error('usage: derive send <task> "message" [--interrupt]')
    await api(`/v1/jobs/${task.id}/messages`, {
      method: "POST",
      body: { body_md: body, ...(flags.interrupt ? { interrupt: true } : {}) },
    })
    log(
      `sent to ${task.id.slice(-6)}${flags.interrupt ? "; its running turn stops and this one runs next" : ""}`,
    )
    return flags.follow ? follow(api, task.id, log) : 0
  }
  if (cmd === "follow") return follow(api, task.id, log)
  if (cmd === "show") {
    console.log(describeTask(await api(`/v1/jobs/${task.id}`), agents))
    return 0
  }
  if (cmd === "stop") {
    await api(`/v1/jobs/${task.id}/cancel`, { method: "POST" })
    log(`stopped ${task.id.slice(-6)}; its machine is retired`)
    return 0
  }
  if (cmd === "forward") {
    const [remote, local = remote] = String(positional[1] ?? "").split(":")
    if (!/^\d+$/.test(remote) || !/^\d+$/.test(local))
      throw new Error("usage: derive forward <task> <port>[:<local port>]")
    await ensureRunning(api, task.id, log)
    const shell = await openShell(api, task.id)
    log(`http://localhost:${local} → session ${task.id.slice(-6)}:${remote} (Ctrl-C to stop)`)
    return (
      spawnSync("ssh", ["-N", "-L", `${local}:127.0.0.1:${remote}`, ...shell.ssh], {
        stdio: "inherit",
      }).status ?? 1
    )
  }
  throw new Error(`unknown command ${cmd}`)
}

async function attach(api, id, log) {
  await ensureRunning(api, id, log)
  const shell = await openShell(api, id)
  // The runner opens tmux a moment after the machine reports running, so wait briefly for it.
  // tmux keeps the session when this terminal closes; the machine parks once it sits idle.
  const join_ = `for i in $(seq 60); do tmux has-session -t ${shell.tmux} 2>/dev/null && exec tmux attach -t ${shell.tmux}; sleep 1; done; echo "the session did not start; see Derive"; exit 1`
  const out = spawnSync("ssh", ["-t", ...shell.ssh, join_], { stdio: "inherit" })
  // Detaching leaves the harness running in tmux; quitting it ends the session's turn.
  const running =
    spawnSync("ssh", [...shell.ssh, `tmux has-session -t ${shell.tmux}`], { stdio: "ignore" })
      .status === 0
  const short = id.slice(-6)
  log(
    running
      ? `detached from ${short}. It keeps running; derive attach ${short} to return.`
      : `session ${short} ended; its machine pauses with your files. derive attach ${short} resumes it.`,
  )
  return out.status ?? 1
}

/** One task, everything Derive knows about where it ran and what it did. */
export function describeTask(t, agents) {
  const agent = agents.find((a) => a.id === t.agent_id)
  const git = t.result?.git
  const pr = t.result?.effects?.find((e) => e.kind === "pr")
  const compute = (t.result?.compute ?? []).reduce((s, c) => s + (c.billable_seconds ?? 0), 0)
  const rows = [
    ["task", `${t.id} · ${state(t)}`],
    ["agent", `${agent?.name ?? "?"} · ${agent?.provider === "codex" ? "codex" : "claude"}`],
    ["runs on", agent?.machine === "derive" ? "Derive cloud" : "its owner's machine"],
    ["started", `${t.created_at}${t.asked_by ? "" : " by a schedule"}`],
    ...(t.machine_waiting ? [["waiting", t.machine_waiting]] : []),
    ...(t.task?.repo ? [["repository", t.task.repo]] : []),
    ...(git ? [["git", `${git.branch ?? "(detached)"} @ ${git.commit?.slice(0, 12) ?? "?"}`]] : []),
    ...(pr ? [["pull request", pr.url ?? pr.ref ?? pr.label]] : []),
    ...(t.result?.failure ? [["failed", t.result.failure.reason]] : []),
    ...(compute ? [["machine time", `${Math.round(compute / 60)} min`]] : []),
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  const recent = (t.events ?? []).filter((e) => e.label).slice(-8)
  return [
    ...rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`),
    ...(recent.length ? ["", "recent activity", ...recent.map((e) => `  · ${e.label}`)] : []),
  ].join("\n")
}

async function follow(api, id, log) {
  let seen = 0
  let acted = 0
  let misses = 0
  for (;;) {
    // A dropped connection (a server restart, a network blip) is waited out, not fatal.
    const task = await api(`/v1/jobs/${id}`).catch((error) => {
      if (error.status || ++misses > 12) throw error
      return null
    })
    if (!task) {
      await sleep(5_000)
      continue
    }
    misses = 0
    for (const e of (task.events ?? []).slice(acted)) if (e.label) log(`  · ${e.label}`)
    acted = task.events?.length ?? 0
    for (const m of task.messages.slice(seen)) if (m.author_kind === "agent") log(m.body_md)
    seen = task.messages.length
    if (!["queued", "running"].includes(task.status)) return task.status === "succeeded" ? 0 : 1
    await sleep(5_000)
  }
}
