// One drain = one `derive runner once` child process. The dispatcher never
// speaks the Derive API itself — the runner owns that contract entirely; this
// file owns only process lifecycle: args, env, timeout, and an output tail
// small enough to put in a log line or a failed-job record.
import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { DispatcherConfig, ManagedContext } from "./config"

export type DrainResult = {
  ok: boolean
  code: number | null
  signal: string | null
  ms: number
  tail: string
}

export const drainArgs = (cfg: DispatcherConfig, ctx: ManagedContext): string[] => [
  "runner",
  "once",
  ctx.id,
  "--server",
  cfg.server,
  ...(ctx.model ? ["--model", ctx.model] : []),
]

const TAIL_MAX = 4_000

type SpawnImpl = (cmd: string, args: string[], opts: object) => ChildProcess

/** Run one drain to completion. Never throws on a bad exit — the caller decides
 *  what a failure means (pg-boss retry semantics live there, not here). The
 *  per-context cwd persists between drains so repo clones and materialized
 *  skills carry over instead of re-fetching every minute. */
export function runDrain(
  cfg: DispatcherConfig,
  ctx: ManagedContext,
  token: string,
  spawnImpl: SpawnImpl = spawn,
): Promise<DrainResult> {
  const cwd = join(cfg.dataDir, ctx.id)
  mkdirSync(cwd, { recursive: true })
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawnImpl(cfg.runnerBin, drainArgs(cfg, ctx), {
      cwd,
      // The runner reads its contract from env; the dispatcher supplies only the
      // per-context token (RUNNER_* knobs pass through). Model credentials are NOT taken
      // from this env: the runner fetches the run's per-user plan from Derive and strips any
      // inherited model token before the spawn, so a global ANTHROPIC_API_KEY / OAuth token
      // set here would simply be ignored.
      env: { ...process.env, DERIVE_TOKEN: token, DERIVE_CONTEXT: ctx.id },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let tail = ""
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-TAIL_MAX)
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    // Two-stage kill: TERM at the deadline (the runner's own timeout should
    // have fired well before this), KILL ten seconds later for a hung child.
    const term = setTimeout(() => child.kill("SIGTERM"), cfg.drainTimeoutMs)
    const kill = setTimeout(() => child.kill("SIGKILL"), cfg.drainTimeoutMs + 10_000)
    child.on("error", (err) => {
      // Spawn itself failed (runner binary missing) — surface it like an exit.
      clearTimeout(term)
      clearTimeout(kill)
      resolve({
        ok: false,
        code: null,
        signal: null,
        ms: Date.now() - started,
        tail: `${tail}\n[dispatcher] spawn failed: ${err.message}`.trim(),
      })
    })
    child.on("exit", (code, signal) => {
      clearTimeout(term)
      clearTimeout(kill)
      resolve({
        ok: code === 0 && signal === null,
        code,
        signal,
        ms: Date.now() - started,
        tail: tail.trim(),
      })
    })
  })
}
