// Runner configuration, environment-only: the runner is an owner-operated daemon
// (it runs where the credentials live), so config travels the same way the
// credentials do — the process environment, never a committed file.

export interface RunnerConfig {
  /** Derive server origin, e.g. https://derive.to */
  server: string
  /** The context's agent bearer (dk_agt_…). */
  token: string
  /** The context id (ctx_…) this runner serves. */
  contextId: string
  /** Where `claude -p` runs — the repo whose .mcp.json/tools the answers need. */
  cwd: string
  claudeBin: string
  /** Model for answer runs. Defaults to sonnet: an asker is sitting in the
   *  console waiting, and data Q&A is tool-call-bound — latency buys more here
   *  than the top model's depth does. RUNNER_MODEL overrides per context. */
  model: string
  timeoutMs: number
  pollMs: number
  /** Skip Claude and post a canned answer — verifies the wiring without a model. */
  mock: boolean
}

// A malformed value must not pass through as NaN: setTimeout(NaN) fires
// immediately, which would turn the poll loop into a busy-loop against the API
// (and an instant "timeout" for every model run).
const positiveMs = (raw: string | undefined, fallback: number, floor: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= floor ? n : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const server = (env.DERIVE_SERVER ?? "").replace(/\/+$/, "")
  const token = env.DERIVE_TOKEN ?? ""
  const contextId = env.DERIVE_CONTEXT ?? ""
  if (!server || !token || !contextId)
    throw new Error("DERIVE_SERVER, DERIVE_TOKEN, and DERIVE_CONTEXT are required")
  return {
    server,
    token,
    contextId,
    cwd: env.RUNNER_CWD ?? process.cwd(),
    claudeBin: env.CLAUDE_BIN ?? "claude",
    model: env.RUNNER_MODEL ?? "sonnet",
    timeoutMs: positiveMs(env.RUNNER_TIMEOUT_MS, 600_000, 10_000),
    pollMs: positiveMs(env.RUNNER_POLL_MS, 5_000, 500),
    mock: env.RUNNER_MOCK === "1",
  }
}
