// The context runner: an owner-operated daemon that answers a Derive context's
// sessions. Poll the queue → run Claude against the manifest → post the answer.
// Polling (not realtime), drain-on-startup (the first poll IS the drain), and
// no auto-retry (failures surface as `failed`) are all inherited from the daniel
// prototype's decision log.

import { buildPrompt, runClaude } from "./claude"
import { type AnswerMeta, DeriveClient, type QueueSession } from "./client"
import { loadConfig } from "./config"

const MOCK_ANSWER = {
  body_md: "Mock answer: the runner is wired correctly (RUNNER_MOCK=1).",
  query: "select 1",
  confidence: 1,
  caveats: ["mock mode — no model was consulted"],
  escalate: false,
  escalation_reason: null,
}

async function serveSession(
  client: DeriveClient,
  session: QueueSession,
  manifest: string,
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  const asked = session.messages.at(-1)?.body_md?.slice(0, 80) ?? "?"
  console.log(`[runner] session ${session.id}: "${asked}"`)
  const result = cfg.mock
    ? { ok: true as const, answer: MOCK_ANSWER }
    : await runClaude({
        bin: cfg.claudeBin,
        cwd: cfg.cwd,
        timeoutMs: cfg.timeoutMs,
        systemPrompt: manifest,
        prompt: buildPrompt(session.messages),
      })
  if (!result.ok || !result.answer) {
    console.error(`[runner] session ${session.id} failed: ${result.error}`)
    await client.fail(session.id)
    return
  }
  const a = result.answer
  const meta: AnswerMeta = {
    query: a.query,
    confidence: a.confidence,
    caveats: a.caveats,
    ...(a.escalate ? { escalation_reason: a.escalation_reason ?? "escalated" } : {}),
  }
  await client.answer(session.id, a.body_md, meta, a.escalate ? "escalated" : "answered")
  console.log(
    `[runner] session ${session.id} ${a.escalate ? "escalated" : "answered"} (confidence ${a.confidence ?? "?"})`,
  )
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const client = new DeriveClient(cfg.server, cfg.token)
  const info = await client.getContext(cfg.contextId)
  if (!info.manifest_md) throw new Error("context has no readable manifest")
  console.log(
    `[runner] serving "${info.name}" (${cfg.contextId}) — manifest v${info.manifest_version}, ` +
      `${cfg.mock ? "MOCK" : cfg.claudeBin}, poll ${cfg.pollMs}ms`,
  )

  for (;;) {
    try {
      // Re-read the manifest each cycle only when the queue has work — an edit to
      // the manifest applies from the next answer, and idle polls stay one call.
      const sessions = await client.queue(cfg.contextId)
      if (sessions.length > 0) {
        const fresh = await client.getContext(cfg.contextId)
        const manifest = fresh.manifest_md ?? info.manifest_md
        // Sessions are served sequentially: one runner, one model, no fan-out —
        // fairness comes from the queue's oldest-first order.
        for (const s of sessions) await serveSession(client, s, manifest, cfg)
      }
    } catch (err) {
      console.error(`[runner] poll error: ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs))
  }
}

main().catch((err) => {
  console.error(`[runner] fatal: ${(err as Error).message}`)
  process.exit(1)
})
