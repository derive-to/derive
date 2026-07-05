// Spawn `claude -p` and extract a structured answer — harvested from the daniel
// prototype's worker (May 2026), which settled this shape: stream-json for live
// visibility, the final `result` event for parsing, and an <answer> JSON block as
// the model's output contract. The IO contract lives HERE, appended to the
// manifest at spawn time — the manifest carries domain knowledge, not mechanics.

import { spawn } from "node:child_process"
import type { QueueMessage } from "./client"

export interface RunnerAnswer {
  body_md: string
  query: string | null
  confidence: number | null
  caveats: string[]
  escalate: boolean
  escalation_reason: string | null
}

export interface RunResult {
  ok: boolean
  answer?: RunnerAnswer
  error?: string
}

// Appended after the manifest so a context author can't accidentally break the
// parse contract by editing their manifest.
export const OUTPUT_CONTRACT = `

## Output format — required

End your FINAL message with a single <answer> block containing JSON (no other
JSON in the final message):

<answer>
{
  "body_md": "The answer, as markdown. Concise summary first, then supporting detail.",
  "query": "the SQL / aggregation used, or null",
  "confidence": 0.0,
  "caveats": ["..."],
  "escalate": false,
  "escalation_reason": null
}
</answer>

Escalate (escalate: true, with a short reason) when the manifest's escalation
rules say so — still produce your best draft in body_md.`

/** The prompt for one run: the session transcript, then the standing question. */
export function buildPrompt(messages: QueueMessage[]): string {
  const transcript = messages
    .map((m) => `[${m.author_kind === "asker" ? "asker" : "you"}] ${m.body_md}`)
    .join("\n\n")
  return `Session transcript:\n\n${transcript}\n\nAnswer the asker's latest message.`
}

/** Extract + validate the <answer> block from the assistant's final text. */
export function parseAnswer(text: string): { answer?: RunnerAnswer; error?: string } {
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/i)
  if (!m?.[1]) return { error: "no <answer> block in result" }
  // Models sometimes wrap the JSON in ```json fences inside the tags.
  const cleaned = m[1]
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch (e) {
    return { error: `answer JSON parse: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== "object") return { error: "answer is not an object" }
  const r = raw as Record<string, unknown>
  if (typeof r.body_md !== "string" || !r.body_md.trim())
    return { error: "body_md must be a non-empty string" }
  return {
    answer: {
      body_md: r.body_md,
      query: typeof r.query === "string" ? r.query : null,
      confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : null,
      caveats: Array.isArray(r.caveats)
        ? r.caveats.filter((x): x is string => typeof x === "string")
        : [],
      escalate: r.escalate === true,
      escalation_reason: typeof r.escalation_reason === "string" ? r.escalation_reason : null,
    },
  }
}

export interface ClaudeOpts {
  bin: string
  cwd: string
  timeoutMs: number
  systemPrompt: string
  prompt: string
}

/** One `claude -p` run. stream-json events are logged as they arrive; the final
 *  `result` event carries the assistant's last message for parseAnswer. */
export function runClaude(opts: ClaudeOpts): Promise<RunResult> {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    opts.systemPrompt + OUTPUT_CONTRACT,
    // Read-only credentials are the safety boundary (the daniel decision):
    // interactive permission prompts would hang a headless subprocess.
    "--dangerously-skip-permissions",
  ]
  return new Promise((resolve) => {
    const child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let buffer = ""
    let resultText = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, opts.timeoutMs)

    child.stdout.on("data", (b: Buffer) => {
      buffer += b.toString()
      let nl = buffer.indexOf("\n")
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
        if (!line) continue
        try {
          const event = JSON.parse(line) as { type?: string; result?: string }
          logEvent(event)
          if (event.type === "result" && typeof event.result === "string") resultText = event.result
        } catch {
          // partial line / non-JSON noise
        }
      }
    })
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (timedOut) return resolve({ ok: false, error: "timed out" })
      if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${stderr.slice(0, 500)}` })
      const parsed = parseAnswer(resultText)
      resolve(
        parsed.answer ? { ok: true, answer: parsed.answer } : { ok: false, error: parsed.error },
      )
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(err) })
    })
  })
}

function logEvent(event: {
  type?: string
  message?: { content?: Array<Record<string, unknown>> }
}): void {
  if (event.type !== "assistant") return
  for (const c of event.message?.content ?? []) {
    if (c.type === "tool_use") console.log(`[claude] → ${String(c.name)}`)
    else if (c.type === "text" && typeof c.text === "string" && c.text.trim())
      console.log(`[claude] ${c.text.replace(/\s+/g, " ").slice(0, 200)}`)
  }
}
