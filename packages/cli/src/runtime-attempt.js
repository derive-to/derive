import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { selectProvider } from "./providers/index.js"

/** One durable attempt. Never retry the model; only replay the same immutable receipt. */
export async function runRuntimeAttempt(cfg) {
  const id = process.env.DERIVE_ATTEMPT_ID
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || cfg.modelAuth !== "ortam")
    throw new Error("Runtime attempts require an attempt ID and Ortam model auth")
  const endpoint = `${cfg.server}/v1/runtime-attempts/${id}`
  const call = async (path, body) => {
    const response = await fetch(endpoint + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Attempt API returned HTTP ${response.status}`)
    return response.json()
  }
  const work = await call("/claim", {})
  if (!work.claimed) return { served: 0, failed: 0 }
  const provider = selectProvider(work.input.provider)
  const remaining = Date.parse(work.deadline_at) - Date.now() - 30000
  let receipt
  if (remaining <= 0)
    receipt = {
      version: 1,
      outcome: "failed",
      summary: "The attempt expired before the agent could start.",
      outputs: [],
    }
  else {
    mkdirSync(cfg.cwd, { recursive: true })
    // Tokens stay in the process environment, never in the saved helper or prompt.
    const env = { ...process.env, ...work.environment }
    for (const key of Object.keys(env))
      if (key.startsWith("DERIVE_") && key !== "DERIVE_RUNNER_ISOLATED") delete env[key]
    const tools = work.tools ?? []
    if (tools.length) {
      env.DERIVE_ATTEMPT_URL = endpoint
      env.DERIVE_TOKEN = cfg.token
      writeFileSync(
        join(cfg.cwd, "derive-source.mjs"),
        `const [tool, args = "{}"] = process.argv.slice(2)
const response = await fetch(process.env.DERIVE_ATTEMPT_URL + "/tool", { method: "POST", redirect: "error", headers: { Authorization: "Bearer " + process.env.DERIVE_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ tool, args: JSON.parse(args) }) })
if (!response.ok) throw new Error("Tool request failed: " + response.status)
console.log(JSON.stringify((await response.json()).result))
`,
        { mode: 0o600 },
      )
    }
    try {
      const result = await provider.run({
        bin: provider.binFrom({}, process.env),
        cwd: cfg.cwd,
        model: work.input.model,
        timeoutMs: Math.min(cfg.timeoutMs, remaining),
        env,
        systemPrompt: `${work.manifest}\n\nKeep useful working files and notes in this directory for later runs. Do not print credentials. Finish with a concise Markdown report describing findings, actions, and unresolved problems.`,
        prompt:
          work.input.instruction +
          (tools.length
            ? `\nSelected tools (call node derive-source.mjs <tool> '<JSON arguments>'):\n${JSON.stringify(tools)}`
            : ""),
      })
      const ok =
        result.code === 0 && !result.timedOut && !result.isError && !!result.resultText?.trim()
      const summary = ok
        ? result.resultText.trim().slice(0, 16000)
        : "The agent did not return a successful report. Inspect the saved workspace before deciding whether to retry."
      receipt = { version: 1, outcome: ok ? "completed" : "failed", summary, outputs: [] }
    } catch {
      receipt = {
        version: 1,
        outcome: "failed",
        summary:
          "The agent could not complete this attempt. Its work was not automatically repeated.",
        outputs: [],
      }
    }
  }
  // A lost response must not lose an otherwise completed report. Replays cannot replace
  // accepted content; a persistent failure exits nonzero and the controller still stops.
  for (let retry = 0; ; retry++) {
    try {
      await call("/result", receipt)
      break
    } catch {
      if (retry >= 2)
        throw new Error("Result delivery could not be confirmed; the agent was not rerun")
      await delay(500 * (retry + 1))
    }
  }
  return { served: 1, failed: receipt.outcome === "failed" ? 1 : 0 }
}
