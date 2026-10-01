// The model half of a runner, shared by the agent runner (job-runner.js): the reply contracts
// and their parsers, the provider call with its retry and nudge, and the guards on what a reply
// may publish. The runner loop itself (pull, serve, report) lives in job-runner.js.

import { readFileSync, realpathSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"

export class DeriveClient {
  constructor(server, token) {
    this.server = server
    this.token = token
  }

  async call(path, init) {
    // Timeboxed: undici's defaults let a blackholed host sit for minutes, which
    // would stall the poll loop (or doctor) with zero output.
    const res = await fetch(`${this.server}${path}`, {
      signal: AbortSignal.timeout(30_000),
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

  // A raw GET (not JSON-parsed) — the content API returns file bytes/text, not JSON.
  async callRaw(path) {
    const res = await fetch(`${this.server}${path}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`${path} → ${res.status}`)
    return res
  }

  /** The skills.js `api`: enumerate a bundle version, fetch one file (bytes, so binary
   *  assets survive), and read a single-file doc's source. A pinned entry carries its
   *  version; an unpinned one (version null) omits `v` so the server serves CURRENT —
   *  interpolating the null ("?v=null") gets a 400 and silently disables the skill. */
  skillApi() {
    const query = (params) => {
      const s = Object.entries(params)
        .filter(([, value]) => value != null)
        .map(([k, value]) => `${k}=${encodeURIComponent(value)}`)
        .join("&")
      return s ? `?${s}` : ""
    }
    return {
      outline: (id, version) =>
        this.call(`/v1/artifacts/${id}/content${query({ outline: 1, v: version })}`),
      file: async (id, path, version) =>
        Buffer.from(
          await (
            await this.callRaw(`/v1/artifacts/${id}/content${query({ section: path, v: version })}`)
          ).arrayBuffer(),
        ),
      content: async (id, version) =>
        (await this.callRaw(`/v1/artifacts/${id}/content${query({ v: version })}`)).text(),
    }
  }
}

// ---- Claude subprocess ---------------------------------------------------------

// The model's output contract. Appended after the agent's instructions so an author
// can't accidentally break the parse contract by editing them.
export const OUTPUT_CONTRACT = `

## Output format — REQUIRED, no matter what you did

However much work you do — queries, building a page, running checks — your
FINAL message MUST END with a single <answer> block of JSON. This is the ONLY
channel your answer reaches the asker through; a reply without it is discarded.
Do not end with prose like "this looks good" — end with the block.

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

When the asker wants a chart, visual, or report page, set "artifact" to ONE
fully self-contained HTML document (inline CSS/JS/SVG, no external requests; it
renders in a sandbox), through either channel:
  - small page — inline it: {"title": "...", "html": "<!doctype html>..."}
  - large page, or one you built with a script — write the file inside your
    WORKING DIRECTORY (not /tmp — a path outside it is refused) and send its
    relative path instead: {"title": "...", "path": "companion.html"}
The runner reads that file and publishes it for you, so a big page never has to
survive being re-typed into JSON. The path must be a .html file that already
exists inside your working directory when you send the block — it names the page
you built, never some other file you happen to have read. It is
published for you and linked under your answer; keep body_md as the prose
summary. Otherwise leave artifact null.`

/** The prompt for one run: the job's transcript, then the standing question.
 *  "Latest message" is the latest ASKER message — on a stale re-serve the
 *  transcript ends with the runner's own superseded answer, and the follow-up
 *  to address sits above it. */
export function buildPrompt(messages) {
  const transcript = messages
    .map((m) => `[${m.author_kind === "asker" ? "asker" : "you"}] ${m.body_md}`)
    .join("\n\n")
  return `Session transcript:\n\n${transcript}\n\nAnswer the asker's latest message (it may sit above your own last reply, if they followed up while you were answering).`
}

// 2MB cap: big enough for any inline-SVG/JS chart, small enough that a runaway
// generation can't turn one answer into a storage-quota event.
const MAX_ARTIFACT_CHARS = 2_000_000

/** Resolve an artifact to the HTML to publish. Inline passes straight through;
 *  a path is read from disk under three guards.
 *
 *  Be honest about what those guards are for. They are NOT a confidentiality
 *  boundary against the model: it runs with permissions skipped in this very
 *  directory, already holds the runner's credentials in its environment, and
 *  can `cp` any file it can read into cwd. What they stop is a path STRING
 *  that shouldn't be honored — one an asker's prompt injection, or a confused
 *  model, points at something that was never meant for publication — and a
 *  mis-aimed path taking the daemon down:
 *    - inside cwd (both sides realpath'd, so a symlink out is an escape;
 *      relative is what the contract asks for, absolute-inside-cwd is tolerated)
 *    - a regular .html/.htm file, so a FIFO can't block the poll loop forever
 *      and a directory/device isn't read at all
 *    - sized BEFORE reading, so a mis-pointed 600MB dump can't OOM the daemon
 *  Returns {html} or {error}; the caller demotes an error to a caveat, never a
 *  failed job. */
export function resolveArtifactHtml(artifact, cwd) {
  if (typeof artifact.html === "string") {
    // parseAnswer already enforces both, but this function is the guard layer
    // its own callers trust — don't let the invariant live in one place only.
    if (!artifact.html.trim()) return { error: "the inline artifact html is empty" }
    if (artifact.html.length > MAX_ARTIFACT_CHARS)
      return { error: "the inline artifact html is over the 2MB cap" }
    return { html: artifact.html }
  }
  const rel = artifact.path
  if (!/\.html?$/i.test(rel))
    return { error: `${rel} is not a .html file — the artifact path must name the page you built` }
  let root
  let full
  let st
  try {
    root = realpathSync(resolve(cwd))
    full = realpathSync(resolve(root, rel))
    st = statSync(full)
  } catch (e) {
    return { error: `cannot read ${rel} (${e.code ?? e.message})` }
  }
  if (full !== root && !full.startsWith(root + sep))
    return { error: `${rel} resolves outside the working directory` }
  if (!st.isFile()) return { error: `${rel} is not a regular file` }
  if (st.size > MAX_ARTIFACT_CHARS)
    return {
      error: `${rel} is ${st.size} bytes — over the ${MAX_ARTIFACT_CHARS}-char artifact cap`,
    }
  let html
  try {
    html = readFileSync(full, "utf8")
  } catch (e) {
    return { error: `cannot read ${rel} (${e.code ?? e.message})` }
  }
  if (!html.trim()) return { error: `${rel} is empty` }
  return { html }
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
  // Two channels, inline first: html when it fits, otherwise a file the runner
  // reads (resolveArtifactHtml). Oversized inline WITH a path falls through to
  // the file rather than dropping the artifact on the floor.
  const a = raw.artifact
  let artifact = null
  if (a && typeof a === "object" && typeof a.title === "string" && a.title.trim()) {
    // Title is model-generated: clamp it to card width, not to trust it less.
    const title = a.title.trim().slice(0, 120)
    if (typeof a.html === "string" && a.html.trim() && a.html.length <= MAX_ARTIFACT_CHARS)
      artifact = { title, html: a.html }
    else if (typeof a.path === "string" && a.path.trim()) artifact = { title, path: a.path.trim() }
  }
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

// The nudge for a run that ended without the <answer> block. Sent as a follow-up
// turn on the SAME claude session (--resume), so the model still holds everything
// it just built — cheap to reformat, and a page it had only written to a file is
// now recovered by pointing at that file rather than re-typing it into JSON.
const NUDGE_PROMPT = `Your previous reply was NOT accepted — it did not end with the required <answer> block, so it never reached the asker. Reply now with ONLY that block and nothing else: <answer>{"body_md":"…","query":…,"confidence":…,"caveats":[…],"escalate":false,"escalation_reason":null,"artifact":…}</answer>. If you built a chart or page, either inline its full HTML in "artifact".html or — if it is large or you already wrote it to a file — send {"title":"…","path":"<relative path inside your working directory>"} and the runner will publish that file — write it into your working directory first if it is currently somewhere else like /tmp. Do not re-type a large page into JSON.`

// The follow-up for a run the API cut short. Resume, don't restart: the session
// still holds everything the model built before the error, which on a long
// review is minutes of tool calls that would otherwise be paid for twice.
const RESUME_PROMPT = `Your previous turn was cut short by a transient service error before you could reply — everything you had already done is still here in this session. Pick up where you left off, finish the job, and end with the required <answer> block.`

/** One `claude -p` run (or resume). Streams events (logged as they arrive),
 *  captures the session id (first system event) and the final `result` text. */
// Long enough to be worth taking. A provider whose CLI does its own backoff has
// already burned attempts over minutes before it surfaces a retryable failure, so
// a short wait would just re-enter the overload window it already gave up on.
export const RETRY_DELAY_MS = 30_000

/** Produce a validated STRUCTURED result from one agent run, robustly and provider-agnostically —
 *  the retry/resume/nudge machine. Generic over the output CONTRACT (appended to the system
 *  prompt), its PARSE (returns {value} or {error}), the NUDGE prompt, and an optional SALVAGE
 *  (raw text -> value). The numbered cases:
 *   1. a parseable block counts EVEN IF the process exited nonzero after emitting it;
 *   2. a transient failure (provider.retryable) retries ONCE, resuming the session when there is one;
 *   3. an ERROR run with no block fails (its text is the API's error, not a result);
 *   4. a clean exit with no block nudges once on the SAME session (a reformat, not new work);
 *   5. real output but still no block SALVAGES it, when a salvage is given.
 *  Returns {ok, value} or {ok:false, error}. (Doc for runStructured below.) */
/**
 * USD (float, as the CLIs report it) → micro-USD (integer, as the column stores it).
 *
 * Integer micros because money in a float sums badly, and the budget SUMs this column across a
 * month of runs. Rounded UP: a sub-micro run is real spend, and flooring it to 0 would let a
 * high-volume cheap agent run free against the cap forever.
 *
 * null in, null out — "we never found out what this cost" is not "this cost nothing", and only
 * the second belongs in a sum. The column is nullable precisely so the difference survives.
 */
export const toMicroUsd = (usd) =>
  Number.isFinite(usd) && usd >= 0 ? Math.ceil(usd * 1_000_000) : null

async function runStructured(provider, opts) {
  const { contract, parse, nudgePrompt, salvage } = opts
  const base = {
    bin: opts.bin,
    cwd: opts.cwd,
    model: opts.model,
    systemPrompt: opts.systemPrompt + contract,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
  }
  const why = (x) => (x.lastText || x.resultText || x.stderr || "").replace(/\s+/g, " ").trim()
  // Cost METER, not a return value. This function has six exits and can spawn the model up to
  // three times (first attempt, one retry, one nudge), and every one of those spends real money —
  // including the ones that end in failure. Accumulating into a caller-owned object means a run
  // reports what it ACTUALLY spent rather than what its last turn cost, and no exit path added
  // later can forget to carry the number.
  const meter = opts.meter ?? { costUsd: null }
  const spend = (x) => {
    if (Number.isFinite(x?.costUsd)) meter.costUsd = (meter.costUsd ?? 0) + x.costUsd
    if (x?.threadId) meter.threadId = x.threadId
    if (x?.usage) meter.usage = x.usage
    if (Array.isArray(x?.actions) && x.actions.length) {
      const collected = meter.actions ?? []
      for (const action of x.actions) {
        if (collected.length >= 50 || JSON.stringify([...collected, action]).length > 4_000) break
        collected.push(action)
      }
      meter.actions = collected
    }
  }
  const started = Date.now()
  let r = await provider.run({ ...base, prompt: opts.prompt, resumeSessionId: null })
  spend(r)
  let parsed = parse(r.resultText)

  if (!parsed.value && provider.retryable(r)) {
    const sid = r.sessionId
    console.error(
      `[runner] run exited ${r.code}${r.apiErrorStatus ? ` (api ${r.apiErrorStatus})` : ""}: ${why(r).slice(0, 160) || "no output"} -- retrying once${sid ? ` (resume ${sid.slice(0, 8)})` : ""}`,
    )
    await new Promise((res) => setTimeout(res, opts.retryDelayMs ?? RETRY_DELAY_MS))
    const left = opts.timeoutMs - (Date.now() - started)
    r = await provider.run({
      ...base,
      timeoutMs: Math.max(left, 120_000),
      prompt: sid ? RESUME_PROMPT : opts.prompt,
      resumeSessionId: sid,
    })
    spend(r)
    parsed = parse(r.resultText)
  }

  if (parsed.value) return { ok: true, value: parsed.value }
  // Transient vs deterministic — the EXECUTOR knows which, the server owns the policy (how
  // many retries, what backoff). A timeout or a provider/spawn failure may well succeed on a
  // second attempt; a clean run that simply never produced the block will fail identically, so
  // saying so keeps a retry from spending the owner's plan twice for the same answer.
  if (r.timedOut) return { ok: false, error: "timed out", retryable: true }
  if (r.code !== 0 || r.isError)
    return {
      ok: false,
      error: `exit ${r.code}: ${why(r).slice(0, 500)}`,
      retryable: provider.retryable(r),
    }

  if (r.sessionId) {
    console.log(`[runner] no block; nudging (resume ${r.sessionId.slice(0, 8)})`)
    const r2 = await provider.run({
      ...base,
      timeoutMs: Math.min(opts.timeoutMs, 180_000),
      prompt: nudgePrompt,
      resumeSessionId: r.sessionId,
    })
    spend(r2)
    const p2 = parse(r2.resultText)
    if (p2.value) return { ok: true, value: p2.value }
  }

  const raw = r.resultText.trim()
  if (salvage && raw) {
    console.log("[runner] salvaging unstructured reply (no block after nudge)")
    const v = salvage(raw)
    if (v) return { ok: true, value: v }
  }
  // A clean exit with no parseable block after a nudge: deterministic, not worth paying for again.
  return { ok: false, error: parsed.error, retryable: false }
}

/** One job's reply. Appends the <answer> contract; salvages an unstructured
 *  reply so a run that did the work isn't lost to a missing block. */
export async function runAgent(provider, opts) {
  const r = await runStructured(provider, {
    ...opts,
    contract: OUTPUT_CONTRACT,
    parse: (t) => {
      const p = parseAnswer(t)
      return p.answer ? { value: p.answer } : { error: p.error }
    },
    nudgePrompt: NUDGE_PROMPT,
    salvage: (raw) => ({
      body_md: raw.slice(0, 20_000),
      query: null,
      confidence: null,
      caveats: [
        "The runner couldn't parse a structured answer, so this is the model's raw reply -- treat any figures and confidence with extra care.",
      ],
      escalate: false,
      escalation_reason: null,
      artifact: null,
    }),
  })
  return r.ok ? { ok: true, answer: r.value } : r
}

// The model-auth env the runner OWNS: every token var the provider CLIs read, CODEX_HOME
// (which points Codex at a login's auth.json), and the base-URL vars (a host value could
// silently redirect the injected token to a proxy). Only the resolved per-user credential may
// set these, so any inherited value is STRIPPED before a spawn (see the session loop). This is
// what makes a stray global token OR login on the host un-billable and un-exfiltratable: there
// is no ambient fallback, and no leftover env can override or redirect the injected plan.
// (Defense in depth on top of the deploy invariant that the runner image carries no host
// `~/.codex` / `~/.claude` login and no baked model token.) Ortam mode explicitly
// restores these values from its single-owner sandbox, which also owns login files.
const MODEL_TOKEN_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
]

/** A copy of `env` with every model-auth var removed, so the caller can layer ONLY the
 *  resolved credential on top. */
export function stripModelTokens(env) {
  const out = { ...env }
  for (const k of MODEL_TOKEN_ENV) delete out[k]
  return out
}
