// The Claude Code provider: drives Anthropic's `claude` CLI. This is the default
// provider and the reference implementation of the AgentProvider shape (see
// ./index.js). Everything Claude-Code-specific lives here — the argv it wants,
// how it streams (`stream-json`), how a failure surfaces (`api_error_status`) —
// so the runner core stays agnostic. Auth is the CLI's own concern: it reads
// ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from the inherited env, so a plan
// token "just works" through the sanctioned client, no reimplementation here.
import { spawn } from "node:child_process"

/** Log one stream event; returns the assistant text it carried (if any), which
 *  the caller keeps as the run's last words for diagnostics. */
function logEvent(event) {
  if (event.type !== "assistant") return ""
  let text = ""
  for (const c of event.message?.content ?? []) {
    if (c.type === "tool_use") console.log(`[claude] → ${String(c.name)}`)
    else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
      text = c.text
      console.log(`[claude] ${c.text.replace(/\s+/g, " ").slice(0, 200)}`)
    }
  }
  return text
}

/** Spawn `claude` once and normalize its stream-json output into the shared
 *  RunResult shape the runner's orchestrator consumes. */
function spawnClaude({ bin, cwd, args, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let buffer = ""
    let resultText = ""
    let sessionId = null
    let stderr = ""
    // The model's last words, kept for the failure message: a crash mid-run
    // exits nonzero with EMPTY stderr, so `exit 1: ` was all an owner ever saw.
    // The reason ("API Error: 529 Overloaded") is in the assistant stream.
    let lastText = ""
    // The CLI's own verdict on the run. An API failure is NOT a silent exit: it
    // emits a result event with is_error + api_error_status and a `result`
    // string carrying the message ("API Error: 529 Overloaded"). Reading those
    // is the difference between "retry, the service was busy" and "don't, the
    // model name is wrong" — the exit code alone can't tell them apart.
    let isError = false
    let apiErrorStatus = null
    let timedOut = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, timeoutMs)
    const take = (line) => {
      try {
        const event = JSON.parse(line)
        lastText = logEvent(event) || lastText
        if (!sessionId && typeof event.session_id === "string") sessionId = event.session_id
        if (event.type === "result") {
          if (typeof event.result === "string") resultText = event.result
          if (event.is_error === true) isError = true
          if (Number.isFinite(event.api_error_status)) apiErrorStatus = event.api_error_status
        }
      } catch {
        // partial line / non-JSON noise
      }
    }
    child.stdout.on("data", (b) => {
      buffer += b.toString()
      let nl = buffer.indexOf("\n")
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
        if (line) take(line)
      }
    })
    child.stderr.on("data", (b) => {
      stderr += b.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      // The stream can end without a trailing newline; the unterminated line may
      // be the `result` event itself.
      if (buffer.trim()) take(buffer.trim())
      resolve({ timedOut, code, resultText, sessionId, stderr, lastText, isError, apiErrorStatus })
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({
        timedOut: false,
        code: -1,
        resultText: "",
        sessionId: null,
        stderr: String(err),
        lastText: "",
        isError: true,
        // A spawn failure (missing binary, missing cwd) never reached the
        // service — deterministic, so it must not look retryable.
        apiErrorStatus: null,
      })
    })
  })
}

export const claudeCode = {
  name: "claude-code",
  // Sonnet by default: an asker is sitting in the console waiting, and data Q&A
  // is tool-call-bound — latency buys more than the top model's depth.
  defaultModel: "sonnet",
  defaultBin: "claude",

  /** Resolve the binary from flags/env, honoring the historical CLAUDE_BIN /
   *  --claude-bin names alongside the generic AGENT_BIN / --agent-bin. */
  binFrom(flags, env) {
    return (
      flags["agent-bin"] ??
      flags["claude-bin"] ??
      env.AGENT_BIN ??
      env.CLAUDE_BIN ??
      this.defaultBin
    )
  },

  /** Run one turn. `systemPrompt` already carries the runner's answer contract;
   *  `resumeSessionId` continues an existing session. --resume does NOT carry the
   *  original --append-system-prompt (verified against the CLI), so we re-send it
   *  on every spawn or a resumed turn would be judged against a contract it can
   *  no longer see. Headless: --dangerously-skip-permissions, because an
   *  interactive prompt would hang the subprocess; the real safety boundary is
   *  the read-only credentials the MCP config carries. */
  async run({ bin, cwd, model, systemPrompt, prompt, timeoutMs, resumeSessionId, env }) {
    const systemArgs = [
      "--append-system-prompt",
      systemPrompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      model,
    ]
    const args = resumeSessionId
      ? ["-p", prompt, "--resume", resumeSessionId, ...systemArgs]
      : ["-p", prompt, ...systemArgs]
    return spawnClaude({ bin, cwd, args, timeoutMs, env })
  },

  /** Is this run worth a second attempt? Only when the SERVICE failed, never
   *  when the configuration did — a wrong model name or a missing binary fails
   *  the same way twice, and paying a sleep plus a second spawn to learn that is
   *  pure latency.
   *    - 429 / 5xx from the API (the 529 that killed a review five minutes deep)
   *    - an engine/turn error: nonzero exit, no api status, nothing to show
   *  Excluded: timeouts (the owner's signal the work doesn't fit the budget),
   *  spawn failures (code -1), and every 4xx (a 404 model_not_found or 401 never
   *  comes good on its own). */
  retryable(r) {
    if (r.timedOut || r.code === 0 || r.code === -1) return false
    if (r.apiErrorStatus != null) return r.apiErrorStatus === 429 || r.apiErrorStatus >= 500
    return true
  },

  /** Map an owner's fetched credential to the env the `claude` CLI reads. A plan/OAuth
   *  token rides CLAUDE_CODE_OAUTH_TOKEN; an API key rides ANTHROPIC_API_KEY. Returns an
   *  env map the runner sets for this (single-owner) run process. */
  credentialEnv(kind, value) {
    return kind === "oauth" ? { CLAUDE_CODE_OAUTH_TOKEN: value } : { ANTHROPIC_API_KEY: value }
  },

  /** Version probe for `derive runner doctor`. Resolves the version string, or
   *  null when the binary is missing / not spawnable. */
  version(bin) {
    return new Promise((resolve) => {
      const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })
      let out = ""
      p.stdout.on("data", (b) => {
        out += b
      })
      p.on("close", (code) => resolve(code === 0 ? out.trim() : null))
      p.on("error", () => resolve(null))
    })
  },
}
