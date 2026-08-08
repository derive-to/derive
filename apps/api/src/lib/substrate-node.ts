import { spawn } from "node:child_process"
import { log } from "../log"
import type { Substrate } from "./dispatch"
import { RUN_TIMEOUT_MS } from "./run-lifecycle"

// The NODE substrate: hosted execution for a self-host that already runs the API on a box.
// One run = one detached `derive runner run <token>` child process on this machine. No
// container runtime, no extra service, no always-on worker beyond the API itself — which is
// what makes this the smallest real "no machine on" story (nothing runs BEYOND the API you
// were already running) and the OSS default.
//
// The child gets ONLY its per-run capability token: no standing agent secret, and no
// third-party source credential (those stay server-side behind the tool endpoint). The model
// plan is fetched by the run itself, scoped to whoever the run bills.

export interface NodeSubstrateOpts {
  /** The derive CLI to spawn (DERIVE_RUNNER_BIN; default `derive` on PATH). */
  bin: string
  /** Hard ceiling for one run; the child is killed past it and the reclaim sweep requeues. */
  timeoutMs?: number
  /** Injectable for tests. */
  spawnImpl?: typeof spawn
}

// The child's environment is built by ALLOWLIST, never by copying process.env.
//
// This process is the API. Its environment holds DERIVE_AUTH_SECRET — the key that signs
// capability tokens and encrypts stored plans — plus DATABASE_URL and whatever else the
// deployment configures. The child is a coding agent running with
// --dangerously-skip-permissions and a shell, on text that can come from a source pull, so
// anything readable in its environment should be assumed published. Handing it the API's
// env would let one poisoned document mint tokens for any agent in any workspace and
// decrypt every stored credential — which is precisely what the header above promises
// doesn't happen. (The container substrate passes four variables and was always right; this
// path is what drifted.)
//
// So: the few variables a process needs to run at all, plus the runner's own configuration
// (which agent binary, which model, timeouts — settings, not secrets), plus the pinned per-run
// identity. NODE_OPTIONS is deliberately absent: it can inject code.
//
// The *_BIN entries are load-bearing and were missed on the first cut of this allowlist. The
// runner resolves its coding agent through AGENT_BIN / CLAUDE_BIN / CODEX_BIN, so withholding
// them does not fail loudly — it falls back to `claude` on PATH, and a deployment that had
// pointed at an explicit binary finds hosted runs quietly executing with the wrong one or none
// at all. Anything the runner legitimately reads from its environment has to be here; the list
// it reads is small and greppable (`env.[A-Z_]+` in packages/cli/src).
const OS_PASSTHROUGH = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  // How the runner finds its coding agent. Configuration, not credentials.
  "AGENT_BIN",
  "CLAUDE_BIN",
  "CODEX_BIN",
  "CLAUDE_MODEL",
  "CODEX_MODEL",
]

const childEnv = (pinned: Record<string, string>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const k of OS_PASSTHROUGH) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("RUNNER_")) out[k] = v
  return { ...out, ...pinned }
}

/** Spawn `derive runner run` per run, detached, with the token in the ENV (never argv — argv
 *  is world-readable in `ps`, and this token can write artifacts). */
export const nodeSubstrate = (opts: NodeSubstrateOpts): Substrate => ({
  name: "node-child",
  async start({ runId, token, server }) {
    const spawnFn = opts.spawnImpl ?? spawn
    const child = spawnFn(opts.bin, ["runner", "run"], {
      // DERIVE_CONTEXT is cleared: this is the context-less run lane.
      env: childEnv({
        DERIVE_TOKEN: token,
        DERIVE_SERVER: server,
        DERIVE_CONTEXT: "",
      }),
      stdio: ["ignore", "pipe", "pipe"],
      // Detached so a slow run isn't tied to an API restart; the reclaim sweep is the
      // backstop if the box goes down mid-run.
      detached: false,
    })
    const tail: string[] = []
    const keep = (b: Buffer) => {
      tail.push(b.toString())
      if (tail.length > 40) tail.shift()
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? RUN_TIMEOUT_MS)
    if (typeof timer.unref === "function") timer.unref()
    child.on("error", (err) => {
      clearTimeout(timer)
      // The commonest real failure: the CLI isn't installed. Say so plainly — a hosted run
      // silently never happening is the worst outcome.
      log.warn("hosted run: could not spawn the derive CLI", {
        run: runId,
        bin: opts.bin,
        error: err.message,
      })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) return
      log.warn("hosted run: executor exited nonzero", {
        run: runId,
        code,
        tail: tail.join("").slice(-600),
      })
    })
    // Resolve as soon as it is STARTED: the run reports its own outcome through the API.
  },
})
