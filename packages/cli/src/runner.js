// The context runner: an owner-operated daemon that answers a Derive context's
// sessions. Poll the queue → run Claude against the manifest → post the answer.
// It polls because the API deliberately has no held connection (Workers
// constraint), and polling makes drain-on-startup free: a closed laptop or a
// rebooted box just delays answers, and the first poll after coming back
// catches up. Failures surface as `failed` sessions and are never auto-retried
// — a retry would mask exactly the manifest/tooling bugs the owner needs to see.
//
// Ported from packages/runner (TS) into the published CLI so `derive runner
// serve` works from a bare npx on any machine — one package, no build step.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

// ---- config -----------------------------------------------------------------

// A malformed value must not pass through as NaN: setTimeout(NaN) fires
// immediately, which would turn the poll loop into a busy-loop against the API
// (and an instant "timeout" for every model run).
const positiveMs = (raw, fallback, floor) => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= floor ? n : fallback
}

/** Resolve runner config: flags win over env; token can come from a file so
 *  service units never embed the secret in their command line. */
export function loadRunnerConfig(env = process.env, flags = {}) {
  // --env-file loads KEY=VALUE files (the context's own secrets, e.g. eda/.env)
  // before anything reads env — replaces the shell-wrapper sourcing dance.
  for (const f of (flags["env-file"] ?? "").split(",").filter(Boolean)) process.loadEnvFile(f)
  const server = (flags.server ?? env.DERIVE_SERVER ?? "https://derive.to").replace(/\/+$/, "")
  const token =
    flags.token ??
    (flags["token-file"]
      ? readFileSync(flags["token-file"], "utf8").replace(/\s+/g, "")
      : env.DERIVE_TOKEN) ??
    ""
  const contextId = flags.context ?? env.DERIVE_CONTEXT ?? ""
  if (!token || !contextId)
    throw new Error(
      "a context id and an agent token are required (positional/--context + --token|--token-file, or DERIVE_CONTEXT + DERIVE_TOKEN)",
    )
  return {
    server,
    token,
    contextId,
    cwd: flags.cwd ?? env.RUNNER_CWD ?? process.cwd(),
    claudeBin: flags["claude-bin"] ?? env.CLAUDE_BIN ?? "claude",
    // Sonnet by default: an asker is sitting in the console waiting, and data
    // Q&A is tool-call-bound — latency buys more than the top model's depth.
    model: flags.model ?? env.RUNNER_MODEL ?? "sonnet",
    timeoutMs: positiveMs(flags.timeout ?? env.RUNNER_TIMEOUT_MS, 600_000, 10_000),
    pollMs: positiveMs(flags.poll ?? env.RUNNER_POLL_MS, 5_000, 500),
    mock: flags.mock === "true" || env.RUNNER_MOCK === "1",
  }
}

// ---- Derive client ------------------------------------------------------------

export class DeriveClient {
  constructor(server, token) {
    this.server = server
    this.token = token
  }

  async call(path, init) {
    const res = await fetch(`${this.server}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    })
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`)
    return res.json()
  }

  getContext(contextId) {
    return this.call(`/v1/contexts/${contextId}`)
  }

  async queue(contextId, limit = 10) {
    const r = await this.call(`/v1/contexts/${contextId}/queue?limit=${limit}`)
    return r.sessions
  }

  /** Post an answer. `answers` names the asker message it addresses — if a
   *  follow-up landed mid-run, the server keeps the session open for re-serve
   *  instead of settling it over the unseen follow-up. */
  answer(sessionId, bodyMd, meta, state, answers) {
    return this.call(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body_md: bodyMd, meta, state, answers }),
    })
  }

  fail(sessionId) {
    return this.call(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "failed" }),
    })
  }

  /** Publish a model-produced visual as a link-visible artifact. Link (not
   *  private): the artifact lands in the AGENT'S REGISTRANT'S library (the
   *  on-behalf model), so a private one would be unreadable to the very asker
   *  it was made for. Link means the URL is the gate — it only travels as far
   *  as session participants choose to send it. */
  async publishArtifact(title, html) {
    const form = new FormData()
    form.set("file", new Blob([html], { type: "text/html" }), "chart.html")
    form.set("title", title)
    form.set("visibility", "link")
    const res = await fetch(`${this.server}/v1/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
    })
    if (!res.ok) throw new Error(`publish → ${res.status}: ${await res.text()}`)
    return res.json()
  }
}

// ---- Claude subprocess ---------------------------------------------------------

// The model's output contract. Appended after the manifest so a context author
// can't accidentally break the parse contract by editing their manifest.
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
  "escalation_reason": null,
  "artifact": null
}
</answer>

Escalate (escalate: true, with a short reason) when the manifest's escalation
rules say so — still produce your best draft in body_md.

When the asker wants a chart, visual, or report page, set "artifact" to
{"title": "...", "html": "<!doctype html>..."} — ONE fully self-contained HTML
document (inline CSS/JS/SVG, no external requests; it renders in a sandbox).
It is published for you and linked under your answer; keep body_md as the
prose summary. Otherwise leave artifact null.`

/** The prompt for one run: the session transcript, then the standing question.
 *  "Latest message" is the latest ASKER message — on a stale re-serve the
 *  transcript ends with the runner's own superseded answer, and the follow-up
 *  to address sits above it. */
export function buildPrompt(messages) {
  const transcript = messages
    .map((m) => `[${m.author_kind === "asker" ? "asker" : "you"}] ${m.body_md}`)
    .join("\n\n")
  return `Session transcript:\n\n${transcript}\n\nAnswer the asker's latest message (it may sit above your own last reply, if they followed up while you were answering).`
}

/** Extract + validate the <answer> block from the assistant's final text. */
export function parseAnswer(text) {
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/i)
  if (!m?.[1]) return { error: "no <answer> block in result" }
  // Models sometimes wrap the JSON in ```json fences inside the tags.
  const cleaned = m[1]
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  let raw
  try {
    raw = JSON.parse(cleaned)
  } catch (e) {
    return { error: `answer JSON parse: ${e.message}` }
  }
  if (!raw || typeof raw !== "object") return { error: "answer is not an object" }
  if (typeof raw.body_md !== "string" || !raw.body_md.trim())
    return { error: "body_md must be a non-empty string" }
  // 2MB cap: big enough for any inline-SVG/JS chart, small enough that a
  // runaway generation can't turn one answer into a storage-quota event.
  const a = raw.artifact
  const artifact =
    a &&
    typeof a === "object" &&
    typeof a.title === "string" &&
    a.title.trim() &&
    typeof a.html === "string" &&
    a.html.trim() &&
    a.html.length <= 2_000_000
      ? // Title is model-generated: clamp it to card width, not to trust it less.
        { title: a.title.trim().slice(0, 120), html: a.html }
      : null
  return {
    answer: {
      artifact,
      body_md: raw.body_md,
      query: typeof raw.query === "string" ? raw.query : null,
      confidence:
        typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : null,
      caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((x) => typeof x === "string") : [],
      escalate: raw.escalate === true,
      escalation_reason: typeof raw.escalation_reason === "string" ? raw.escalation_reason : null,
    },
  }
}

/** One `claude -p` run. stream-json events are logged as they arrive; the final
 *  `result` event carries the assistant's last message for parseAnswer. */
export function runClaude(opts) {
  const args = [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    opts.systemPrompt + OUTPUT_CONTRACT,
    // Headless: an interactive permission prompt would hang the subprocess.
    // The safety boundary is the credentials the MCP config carries — read-only.
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
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, opts.timeoutMs)

    child.stdout.on("data", (b) => {
      buffer += b.toString()
      let nl = buffer.indexOf("\n")
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
        if (!line) continue
        try {
          const event = JSON.parse(line)
          logEvent(event)
          if (event.type === "result" && typeof event.result === "string") resultText = event.result
        } catch {
          // partial line / non-JSON noise
        }
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
      const tail = buffer.trim()
      if (tail) {
        try {
          const event = JSON.parse(tail)
          if (event.type === "result" && typeof event.result === "string") resultText = event.result
        } catch {
          // not JSON — nothing to salvage
        }
      }
      if (timedOut) return resolve({ ok: false, error: "timed out" })
      if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${stderr.slice(0, 500)}` })
      const parsed = parseAnswer(resultText)
      resolve(
        parsed.answer ? { ok: true, answer: parsed.answer } : { ok: false, error: parsed.error },
      )
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ ok: false, error: String(err) })
    })
  })
}

function logEvent(event) {
  if (event.type !== "assistant") return
  for (const c of event.message?.content ?? []) {
    if (c.type === "tool_use") console.log(`[claude] → ${String(c.name)}`)
    else if (c.type === "text" && typeof c.text === "string" && c.text.trim())
      console.log(`[claude] ${c.text.replace(/\s+/g, " ").slice(0, 200)}`)
  }
}

// ---- serve --------------------------------------------------------------------

const MOCK_ANSWER = {
  body_md: "Mock answer: the runner is wired correctly (mock mode).",
  query: "select 1",
  confidence: 1,
  caveats: ["mock mode — no model was consulted"],
  escalate: false,
  escalation_reason: null,
  artifact: null,
}

async function serveSession(client, session, manifest, cfg) {
  const asked = session.messages.at(-1)?.body_md?.slice(0, 80) ?? "?"
  console.log(`[runner] session ${session.id}: "${asked}"`)
  const result = cfg.mock
    ? { ok: true, answer: MOCK_ANSWER }
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
  const meta = {
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
    const arts = m.meta?.artifacts
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
      const reason = err.message.slice(0, 120)
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

export async function serve(cfg) {
  const client = new DeriveClient(cfg.server, cfg.token)
  const info = await client.getContext(cfg.contextId)
  if (!info.manifest_md) throw new Error("context has no readable manifest")
  console.log(
    `[runner] serving "${info.name}" (${cfg.contextId}) — manifest v${info.manifest_version}, ` +
      `${cfg.mock ? "MOCK" : `${cfg.claudeBin} (${cfg.model})`}, poll ${cfg.pollMs}ms`,
  )

  for (;;) {
    try {
      // An open session ending on an agent turn is one of two things: a settle
      // whose state write was lost (the store's two writes aren't transactional)
      // — re-answering would double-post, skip it — or an answer the server
      // marked stale because a follow-up landed mid-run: that one MUST re-serve,
      // and the transcript above the stale answer carries the follow-up.
      const sessions = (await client.queue(cfg.contextId)).filter((s) => {
        const last = s.messages.at(-1)
        if (last?.author_kind !== "agent") return true
        return last.meta?.stale === true
      })
      if (sessions.length > 0) {
        // Re-read the manifest only when the queue has work — an edit applies
        // from the next answer, and idle polls stay one call.
        const fresh = await client.getContext(cfg.contextId)
        const manifest = fresh.manifest_md ?? info.manifest_md
        // Sequential on purpose: one runner, one model, no fan-out — fairness
        // comes from the queue's oldest-first order. One session's failure must
        // not starve the rest of the batch.
        for (const s of sessions) {
          try {
            await serveSession(client, s, manifest, cfg)
          } catch (err) {
            console.error(`[runner] session ${s.id}: ${err.message}`)
          }
        }
      }
    } catch (err) {
      console.error(`[runner] poll error: ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs))
  }
}

// ---- doctor ---------------------------------------------------------------------

/** Preflight the runner's environment; returns the number of hard failures.
 *  Everything that ever broke a runner in the field is checked here so it
 *  breaks at install time instead of at question time. */
export async function doctor(cfg) {
  let failures = 0
  const ok = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`)
  const bad = (label, detail) => {
    console.error(`  ✖ ${label} — ${detail}`)
    failures++
  }
  const warn = (label, detail) => console.warn(`  ⚠ ${label} — ${detail}`)

  try {
    const res = await fetch(`${cfg.server}/healthz`)
    res.ok ? ok("server reachable", cfg.server) : bad("server", `${cfg.server} → ${res.status}`)
  } catch (e) {
    bad("server", `${cfg.server} unreachable (${e.message})`)
  }

  try {
    const info = await new DeriveClient(cfg.server, cfg.token).getContext(cfg.contextId)
    info.manifest_md
      ? ok("context + manifest", `"${info.name}" manifest v${info.manifest_version}`)
      : bad("manifest", "context resolves but its manifest is unreadable")
  } catch (e) {
    bad("token/context", `cannot resolve ${cfg.contextId} (${e.message.slice(0, 120)})`)
  }

  // launchd/systemd PATHs don't include shell profile additions — the exact
  // failure mode that produced `spawn claude ENOENT` in the field.
  const version = await new Promise((resolve) => {
    const p = spawn(cfg.claudeBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    p.stdout.on("data", (b) => {
      out += b
    })
    p.on("close", (code) => resolve(code === 0 ? out.trim() : null))
    p.on("error", () => resolve(null))
  })
  version
    ? ok("claude", `${cfg.claudeBin} (${version.slice(0, 40)})`)
    : bad("claude", `${cfg.claudeBin} not spawnable — pass --claude-bin with an absolute path`)

  for (const tool of ["gh", "python3"]) {
    const present = await new Promise((resolve) => {
      const p = spawn(tool, ["--version"], { stdio: "ignore" })
      p.on("close", (code) => resolve(code === 0))
      p.on("error", () => resolve(false))
    })
    present ? ok(tool) : warn(tool, "not on PATH — fine unless this context's manifest needs it")
  }

  console.log(failures === 0 ? "\ndoctor: all checks passed" : `\ndoctor: ${failures} failure(s)`)
  return failures
}

// ---- install ---------------------------------------------------------------------

/** Render a service unit (launchd plist on darwin, systemd on linux) that runs
 *  `derive runner serve` with this config. Printed for the operator to install —
 *  writing into system locations stays a human action. */
export function renderServiceUnit(cfg, binPath, platform = process.platform) {
  const label = `to.derive.runner.${cfg.contextId.replace(/^ctx_/, "")}`
  const argv = [
    process.execPath,
    binPath,
    "runner",
    "serve",
    cfg.contextId,
    "--server",
    cfg.server,
    "--cwd",
    cfg.cwd,
    "--claude-bin",
    cfg.claudeBin,
    "--model",
    cfg.model,
  ]
  if (cfg.tokenFile) argv.push("--token-file", cfg.tokenFile)
  if (platform === "darwin") {
    const xml = argv.map((a) => `    <string>${a}</string>`).join("\n")
    return {
      path: `~/Library/LaunchAgents/${label}.plist`,
      load: `launchctl load ~/Library/LaunchAgents/${label}.plist`,
      unit: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${xml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key><string>/tmp/${label}.log</string>
</dict>
</plist>`,
    }
  }
  return {
    path: `/etc/systemd/system/${label}.service`,
    load: `sudo systemctl enable --now ${label}`,
    unit: `[Unit]
Description=Derive context runner (${cfg.contextId})
After=network-online.target

[Service]
ExecStart=${argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`,
  }
}
