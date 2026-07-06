// The context runner: an owner-operated daemon that answers a Derive context's
// sessions. Poll the queue → run Claude against the manifest → post the answer.
// It polls because the API deliberately has no held connection (Workers
// constraint), and polling makes drain-on-startup free: a closed laptop just
// delays answers, and the first poll after reopening catches up. Failures
// surface as `failed` sessions and are never auto-retried — a retry would mask
// exactly the manifest/tooling bugs the owner needs to see.

import { buildPrompt, type RunnerAnswer, runClaude } from "./claude"
import { type AnswerMeta, DeriveClient, type QueueSession } from "./client"
import { loadConfig } from "./config"

const MOCK_ANSWER: RunnerAnswer = {
  body_md: "Mock answer: the runner is wired correctly (RUNNER_MOCK=1).",
  query: "select 1",
  confidence: 1,
  caveats: ["mock mode — no model was consulted"],
  escalate: false,
  escalation_reason: null,
  artifact: null,
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
        model: cfg.model,
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
  // Publish the answer's visual, if it produced one. A publish failure demotes
  // to a caveat rather than failing the session — the prose answer still stands
  // — and the caveat carries the reason, because a permanent 403 (agent below
  // editor) would otherwise look identical to a network blip. Per-session cap:
  // every artifact spends the OWNER's storage/artifact quota, so an asker
  // looping "add a chart" must hit a floor before the workspace does.
  const priorArtifacts = session.messages.reduce((n, m) => {
    const arts = (m.meta as { artifacts?: unknown[] } | null)?.artifacts
    return n + (Array.isArray(arts) ? arts.length : 0)
  }, 0)
  if (a.artifact && priorArtifacts >= 10) {
    meta.caveats = [...a.caveats, "chart skipped — this session already published 10 artifacts"]
  } else if (a.artifact) {
    try {
      const pub = await client.publishArtifact(a.artifact.title, a.artifact.html)
      meta.artifacts = [{ short_id: pub.short_id, title: a.artifact.title }]
      console.log(`[runner] published artifact ${pub.short_id} ("${a.artifact.title}")`)
    } catch (err) {
      const reason = (err as Error).message.slice(0, 120)
      meta.caveats = [...a.caveats, `a chart was produced but failed to publish (${reason})`]
      console.error(`[runner] artifact publish failed: ${reason}`)
    }
  }
  const lastAsker = session.messages.filter((m) => m.author_kind === "asker").at(-1)
  try {
    await client.answer(
      session.id,
      a.body_md,
      meta,
      a.escalate ? "escalated" : "answered",
      lastAsker?.id,
    )
  } catch (err) {
    // The publish already happened; a failed answer post (asker closed mid-run
    // → 409, network) strands it. Name the orphan so the owner can clean it up
    // — the runner itself can't delete artifacts, by design.
    if (meta.artifacts?.length)
      console.error(`[runner] answer post failed; orphaned artifact ${meta.artifacts[0]?.short_id}`)
    throw err
  }
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
      `${cfg.mock ? "MOCK" : `${cfg.claudeBin} (${cfg.model})`}, poll ${cfg.pollMs}ms`,
  )

  for (;;) {
    try {
      // Re-read the manifest each cycle only when the queue has work — an edit to
      // the manifest applies from the next answer, and idle polls stay one call.
      // An open session ending on an agent turn is one of two things: a settle
      // whose state write was lost (the store's two writes aren't transactional)
      // — re-answering would double-post, skip it — or an answer the server
      // marked stale because a follow-up landed mid-run: that one MUST re-serve,
      // and the transcript above the stale answer carries the follow-up.
      const sessions = (await client.queue(cfg.contextId)).filter((s) => {
        const last = s.messages.at(-1)
        if (last?.author_kind !== "agent") return true
        return (last.meta as { stale?: boolean } | null)?.stale === true
      })
      if (sessions.length > 0) {
        const fresh = await client.getContext(cfg.contextId)
        const manifest = fresh.manifest_md ?? info.manifest_md
        // Sequential on purpose: one runner, one model, no fan-out — fairness
        // comes from the queue's oldest-first order. One session's failure must
        // not starve the rest of the batch.
        for (const s of sessions) {
          try {
            await serveSession(client, s, manifest, cfg)
          } catch (err) {
            console.error(`[runner] session ${s.id}: ${(err as Error).message}`)
          }
        }
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
