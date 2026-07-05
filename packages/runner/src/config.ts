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
  timeoutMs: number
  pollMs: number
  /** Skip Claude and return a canned answer — the smoke-test mode (daniel's Day 1). */
  mock: boolean
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
    timeoutMs: Number(env.RUNNER_TIMEOUT_MS ?? 600_000),
    pollMs: Number(env.RUNNER_POLL_MS ?? 5_000),
    mock: env.RUNNER_MOCK === "1",
  }
}
