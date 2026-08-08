// The Codex provider: drives OpenAI's `codex` CLI (`codex exec`). Like Claude
// Code, it authenticates itself from the inherited env — a ChatGPT-plan login
// (`codex login`) or CODEX_API_KEY — so a plan token flows through the official
// client, never a reimplemented one.
//
// The hosted image pins the CLI version this adapter is verified against. JSONL is important:
// it gives the run a durable action receipt (commands, file changes, MCP calls, plan updates)
// while leaving the final answer contract provider-agnostic.
import { spawn } from "node:child_process"

const ACTION_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "plan_update",
])

const clipped = (value, max = 300) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)

const safeCommand = (value) =>
  clipped(value, 200)
    .replace(/\b(dk(?:run|sess|_agt)?_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))=\S+/g, "$1=[redacted]")
    .replace(/(authorization\s*[:=]?\s*bearer)\s+\S+/gi, "$1 [redacted]")

/** Keep evidence useful without persisting command output, absolute temp roots, or secrets. */
function actionOf(item, cwd) {
  if (!item || !ACTION_TYPES.has(item.type)) return null
  if (item.type === "command_execution")
    return {
      type: item.type,
      command: safeCommand(item.command),
      exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
    }
  if (item.type === "file_change")
    return {
      type: item.type,
      changes: (item.changes ?? []).slice(0, 8).map((change) => ({
        path:
          typeof change.path === "string" && change.path.startsWith(`${cwd}/`)
            ? change.path.slice(cwd.length + 1)
            : clipped(change.path, 120),
        kind: clipped(change.kind, 40),
      })),
    }
  return {
    type: item.type,
    name: clipped(item.name ?? item.tool ?? item.query ?? item.text, 160),
  }
}

/** Spawn `codex exec --json` once and normalize its event stream. */
function spawnCodex({ bin, cwd, args, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let buffer = ""
    let resultText = ""
    let threadId = null
    let usage = null
    const actions = []
    let stderr = ""
    let lastText = ""
    let isError = false
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
        if (event.type === "thread.started" && typeof event.thread_id === "string")
          threadId = event.thread_id
        if (event.type === "item.completed") {
          const item = event.item
          if (item?.type === "agent_message" && typeof item.text === "string") {
            resultText = item.text
            lastText = clipped(item.text, 200)
          }
          const action = actionOf(item, cwd)
          // The finish endpoint's complete metadata record is capped at 8 KiB. Bound by the
          // serialized receipt size (not only count), because one file-change event can carry
          // many paths. A truncated receipt is evidence; a rejected finish leaves work stuck.
          if (
            action &&
            actions.length < 50 &&
            JSON.stringify([...actions, action]).length <= 4_000
          ) {
            actions.push(action)
            console.log(`[codex] → ${action.type}`)
          }
        }
        if (event.type === "turn.completed" && event.usage) usage = event.usage
        if (event.type === "turn.failed" || event.type === "error") {
          isError = true
          lastText = clipped(event.error?.message ?? event.message ?? event.error, 200) || lastText
        }
      } catch {
        // A CLI diagnostic can share stdout with JSONL. Keep it out of the answer contract.
      }
    }
    child.stdout.on("data", (b) => {
      buffer += b.toString()
      let nl = buffer.indexOf("\n")
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) take(line)
        nl = buffer.indexOf("\n")
      }
    })
    child.stderr.on("data", (b) => {
      stderr += b.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (buffer.trim()) take(buffer.trim())
      resolve({
        timedOut,
        code,
        resultText,
        // Ephemeral runs intentionally cannot resume. Keep the thread id as receipt evidence,
        // but make the orchestrator retry from a clean process if needed.
        sessionId: null,
        threadId,
        stderr,
        lastText,
        isError: isError || code !== 0,
        // Codex plain-text mode surfaces no structured api status; the exit code
        // is the only signal, so retryable() falls back to "engine error".
        apiErrorStatus: null,
        // ChatGPT-plan runs do not report dollar cost. Null is unknown, never free.
        costUsd: null,
        actions,
        usage,
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
        threadId: null,
        stderr: String(err),
        lastText: "",
        isError: true,
        apiErrorStatus: null,
        costUsd: null,
        actions: [],
        usage: null,
      })
    })
  })
}

export const codex = {
  name: "codex",
  // Let the verified CLI/account choose its current default unless a deployment pins RUNNER_MODEL.
  defaultModel: null,
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
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      ...(env?.DERIVE_RUNNER_ISOLATED === "1"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--sandbox", "workspace-write"]),
      ...(model ? ["--model", model] : []),
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

  /** Map an owner's credential to Codex's automation-only env. A key rides CODEX_API_KEY. A
   *  ChatGPT-plan login is file-based (see credentialFiles), so it returns null here. */
  credentialEnv(kind, value) {
    return kind === "api_key" ? { CODEX_API_KEY: value } : null
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
