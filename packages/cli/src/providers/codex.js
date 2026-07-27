// The Codex provider: drives OpenAI's `codex` CLI (`codex exec`). Like Claude
// Code, it authenticates itself from the inherited env — a ChatGPT-plan login
// (`codex login`) or OPENAI_API_KEY — so a plan token flows through the official
// client, never a reimplemented one.
//
// EXPERIMENTAL: the argv and I/O below follow Codex's documented `exec` shape but
// have NOT been verified against a pinned binary in this tree; the flag names are
// the one thing to confirm with `codex exec --help` before relying on it. It is
// written conservatively on purpose:
//   - plain stdout is the reply (no JSON-event schema to track); the runner's
//     <answer> contract rides in the system prompt, so parsing is unchanged.
//   - no session resume (Codex's resume semantics differ); a transient failure
//     retries from scratch rather than resuming, which the orchestrator handles.
// Both are safe degradations, not correctness gaps — see ./index.js for the shape.
import { spawn } from "node:child_process"

/** Spawn `codex exec` once and capture stdout as the reply text. */
function spawnCodex({ bin, cwd, args, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let stderr = ""
    let timedOut = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, timeoutMs)
    child.stdout.on("data", (b) => {
      out += b.toString()
    })
    child.stderr.on("data", (b) => {
      stderr += b.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({
        timedOut,
        code,
        // The whole reply is the result text; the runner extracts the <answer>
        // block from it exactly as it does for any provider.
        resultText: out,
        // No session model here — a retry restarts rather than resumes.
        sessionId: null,
        stderr,
        lastText: out.replace(/\s+/g, " ").slice(-200),
        isError: code !== 0,
        // Codex plain-text mode surfaces no structured api status; the exit code
        // is the only signal, so retryable() falls back to "engine error".
        apiErrorStatus: null,
        // Plain-text mode reports no cost either. Null = UNKNOWN, which the server stores as a
        // null column and the budget's sum skips — a Codex run is honestly unpriced rather than
        // silently counted as free. Structured output would be what makes this reportable.
        costUsd: null,
      })
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
        apiErrorStatus: null,
        costUsd: null,
      })
    })
  })
}

export const codex = {
  name: "codex",
  defaultModel: "gpt-5-codex",
  defaultBin: "codex",

  binFrom(flags, env) {
    return flags["agent-bin"] ?? env.AGENT_BIN ?? env.CODEX_BIN ?? this.defaultBin
  },

  /** Run one turn. Codex takes a single prompt, so the system prompt (which
   *  carries the answer contract) is prepended to the task rather than passed as
   *  a separate flag. resumeSessionId is ignored (no resume). */
  async run({ bin, cwd, model, systemPrompt, prompt, timeoutMs, env }) {
    const args = [
      "exec",
      "--model",
      model,
      // Non-interactive: skip approvals, like the Claude provider's headless mode.
      "--dangerously-bypass-approvals-and-sandbox",
      `${systemPrompt}\n\n---\n\n${prompt}`,
    ]
    return spawnCodex({ bin, cwd, args, timeoutMs, env })
  },

  /** Without a structured api status, a nonzero exit that produced no output is
   *  treated as an engine error worth one retry; a spawn failure (code -1) and a
   *  timeout are not. Mirrors the claude-code policy on the signals Codex gives. */
  retryable(r) {
    if (r.timedOut || r.code === 0 || r.code === -1) return false
    return true
  },

  /** Map an owner's credential to Codex's env. An API key rides OPENAI_API_KEY. A
   *  ChatGPT-plan login is file-based (see credentialFiles), so it returns null here. */
  credentialEnv(kind, value) {
    return kind === "api_key" ? { OPENAI_API_KEY: value } : null
  },

  /** A ChatGPT-plan login is delivered as a FILE: Codex reads `auth.json` from `$CODEX_HOME`
   *  (default ~/.codex). The stored `login` credential IS that file's JSON, so the runner
   *  writes it into a private per-run CODEX_HOME and points Codex at it. The official CLI then
   *  authenticates on the subscription exactly as if you had run `codex login` there. Other
   *  kinds are env-delivered (credentialEnv), so this returns null for them. */
  credentialFiles(kind, value) {
    return kind === "login" ? { homeEnv: "CODEX_HOME", files: { "auth.json": value } } : null
  },

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
