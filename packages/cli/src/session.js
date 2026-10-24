// An interactive session on a Derive machine: the agent's own harness (Claude Code or Codex) in
// a tmux session a person attaches to over SSH (`derive attach`). The runner keeps the task's
// claim alive while the session is in use and ends the turn when the harness exits, or when nobody
// has typed and its screen has not changed for the idle window; the machine then parks with its
// files, and the next attach resumes the same conversation.
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SESSION_TMUX } from "./conversation-format.js"

/** How long a session may sit detached and quiet before its machine parks. */
const IDLE_MS = 20 * 60_000
const POLL_MS = 10_000

const realTmux = (...args) => spawnSync("tmux", args, { encoding: "utf8", timeout: 10_000 })
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

/** Start the harness in tmux and wait for the session to end. Returns why it ended: `exited`
 *  (the harness quit), `idle`, or `stopped` (the claim was lost or the task cancelled). */
export async function runSession(
  { bin, args, cwd, env, signal },
  { idleMs = IDLE_MS, pollMs = POLL_MS, now = Date.now, tmux = realTmux } = {},
) {
  tmux("kill-session", "-t", SESSION_TMUX)
  // The model login and job tokens reach the harness through a private file the wrapper
  // deletes before exec, never through argv, which any process on the machine can read. The
  // harness command line rides the same file: an agent's instructions page travels in
  // `--append-system-prompt`, and tmux refuses a new-session command past its own limit
  // ("command too long"), so the arguments never go through tmux at all.
  const dir = mkdtempSync(join(tmpdir(), "derive-session-"))
  const envFile = join(dir, "env")
  writeFileSync(
    envFile,
    [
      ...Object.entries(env ?? {}).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
      // A shell variable, not exported: the harness never sees its own command line twice.
      `DERIVE_SESSION_COMMAND=${shellQuote([bin, ...args].map(shellQuote).join(" "))}`,
    ].join("\n"),
    { mode: 0o600 },
  )
  const started = tmux(
    "new-session",
    "-d",
    "-s",
    SESSION_TMUX,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    cwd,
    "sh",
    "-c",
    '. "$1"; rm -rf "$(dirname "$1")"; eval "exec $DERIVE_SESSION_COMMAND"',
    "derive-session",
    envFile,
  )
  if (started.status !== 0)
    throw Object.assign(new Error(`could not start the session: ${started.stderr.trim()}`), {
      retryable: false,
    })
  let lastSeen = now()
  let screen = null
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (signal?.aborted) {
      tmux("kill-session", "-t", SESSION_TMUX)
      return "stopped"
    }
    if (tmux("has-session", "-t", SESSION_TMUX).status !== 0) return "exited"
    // In use while someone typed recently (a dropped connection can leave a client listed long
    // after its person left, so its own last activity counts, not its presence) or while the
    // screen is still changing (the harness working). A redraw that changes nothing is not use.
    const typed = tmux("list-clients", "-t", SESSION_TMUX, "-F", "#{client_activity}")
      .stdout.split("\n")
      .map((line) => Number(line.trim()) * 1000)
      .filter((at) => Number.isFinite(at) && at > 0)
    lastSeen = Math.max(lastSeen, ...typed)
    const shown = tmux("capture-pane", "-p", "-t", SESSION_TMUX).stdout
    if (shown !== screen) {
      screen = shown
      lastSeen = now()
    }
    if (now() - lastSeen > idleMs) {
      tmux("kill-session", "-t", SESSION_TMUX)
      return "idle"
    }
  }
}
