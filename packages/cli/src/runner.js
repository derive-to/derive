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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { claudeCode } from "./providers/claude-code.js"
import { DEFAULT_PROVIDER, PROVIDERS, selectProvider } from "./providers/index.js"
import {
  conventionsBlock,
  materializeNotes,
  materializeSkills,
  mergeSkillLayers,
} from "./skills.js"

// ---- config -----------------------------------------------------------------

// A malformed value must not pass through as NaN: setTimeout(NaN) fires
// immediately, which would turn the poll loop into a busy-loop against the API
// (and an instant "timeout" for every model run).
const positiveMs = (raw, fallback, floor) => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= floor ? n : fallback
}

/** Apply a KEY=VALUE env file into `env`. File values OVERRIDE ambient env —
 *  the same semantics as `source`ing the file, which is what --env-file
 *  replaces. (process.loadEnvFile has it backwards for our purpose: ambient
 *  wins, so a stale DERIVE_TOKEN exported in a shell would silently beat the
 *  fresh one in the file.) */
function applyEnvFile(path, env) {
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    throw new Error(`--env-file ${path}: ${e.message}`)
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1)
    env[m[1]] = v
  }
}

/** Resolve runner config: flags win over env; token can come from a file so
 *  service units never embed the secret in their command line. `partial` lets
 *  doctor run its checks on a half-configured machine — missing token/context
 *  becomes a doctor finding instead of an error before the first check. */
export function loadRunnerConfig(env = process.env, flags = {}, { partial = false } = {}) {
  // --env-file loads a context's own secrets (e.g. eda/.env with the MCP
  // credentials) before anything reads env. Applied to `env`, not the global:
  // in the CLI they're the same object, so spawned claude inherits the values,
  // but a caller passing its own env (tests) stays isolated.
  const envFiles = (flags["env-file"] ?? "").split(",").filter(Boolean)
  for (const f of envFiles) applyEnvFile(f, env)
  // Cloud default, like every other CLI verb. serve() prints the server in its
  // first log line, so a self-hoster who forgot --server sees it immediately.
  const server = (flags.server ?? env.DERIVE_SERVER ?? "https://derive.to").replace(/\/+$/, "")
  const token =
    flags.token ??
    (flags["token-file"]
      ? readFileSync(flags["token-file"], "utf8").replace(/\s+/g, "")
      : env.DERIVE_TOKEN) ??
    ""
  const contextId = flags.context ?? env.DERIVE_CONTEXT ?? ""
  if ((!token || !contextId) && !partial)
    throw new Error(
      "a context id and an agent token are required (positional/--context + --token|--token-file, or DERIVE_CONTEXT + DERIVE_TOKEN)",
    )
  // Which agent CLI drives the runs. Default claude-code; the provider owns its
  // binary resolution and default model so this stays agnostic. An unknown name
  // is fatal for a real run, but in `partial` mode (doctor) it must degrade to a
  // FINDING, not a crash — the same contract as a missing token/context — so we
  // fall back to the default for the derived defaults and let doctor report it.
  const providerName = flags.provider ?? env.RUNNER_PROVIDER ?? DEFAULT_PROVIDER
  const provider = partial
    ? (PROVIDERS[providerName] ?? PROVIDERS[DEFAULT_PROVIDER])
    : selectProvider(providerName)
  return {
    server,
    token,
    contextId,
    cwd: flags.cwd ?? env.RUNNER_CWD ?? process.cwd(),
    providerName,
    agentBin: provider.binFrom(flags, env),
    // The provider's default (claude-code → sonnet): an asker is sitting in the
    // console waiting, and data Q&A is tool-call-bound, so latency buys more than
    // the top model's depth. --model / RUNNER_MODEL override it.
    model: flags.model ?? env.RUNNER_MODEL ?? provider.defaultModel,
    timeoutMs: positiveMs(flags.timeout ?? env.RUNNER_TIMEOUT_MS, 600_000, 10_000),
    pollMs: positiveMs(flags.poll ?? env.RUNNER_POLL_MS, 5_000, 500),
    mock: flags.mock === "true" || env.RUNNER_MOCK === "1",
    // Dev mode (`derive context dev`): the system prompt comes from this local
    // file instead of the pushed manifest — edit, save, and the next answer
    // uses it, no push. Sessions and answers still go through the server.
    manifestFile: flags["manifest-file"] ?? null,
    // Carried so `runner install` can reproduce this exact config in a unit —
    // a rendered service that silently dropped the env files would boot a
    // runner whose MCP servers have no credentials.
    envFiles,
    tokenFile: flags["token-file"] ?? null,
  }
}

// ---- Derive client ------------------------------------------------------------

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
   *  assets survive), and read a single-file doc's source — all pinned by version. */
  skillApi() {
    return {
      outline: (id, version) => this.call(`/v1/artifacts/${id}/content?outline=1&v=${version}`),
      file: async (id, path, version) =>
        Buffer.from(
          await (
            await this.callRaw(
              `/v1/artifacts/${id}/content?section=${encodeURIComponent(path)}&v=${version}`,
            )
          ).arrayBuffer(),
        ),
      content: async (id, version) =>
        (await this.callRaw(`/v1/artifacts/${id}/content?v=${version}`)).text(),
    }
  }

  getContext(contextId) {
    return this.call(`/v1/contexts/${contextId}`)
  }

  async queue(contextId, limit = 10) {
    const r = await this.call(`/v1/contexts/${contextId}/queue?limit=${limit}`)
    return r.sessions
  }

  /** The owner's connected model credential for a provider (decrypted), or null. The
   *  server scopes it to THIS agent's registrant, so a runner only ever sees its own
   *  owner's plan token. */
  async modelCredential(provider, sessionId = null) {
    const q = `provider=${encodeURIComponent(provider)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`
    const r = await this.call(`/v1/agent/model-credential?${q}`)
    return r.credential ?? null
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

  /** Publish a model-produced visual as a workspace-visible artifact. Org (not
   *  private): the artifact lands in the AGENT'S REGISTRANT'S library (the
   *  on-behalf model), so a private one would be unreadable to the very asker
   *  it was made for — and askers are workspace members, so a chart answering
   *  their question is workspace work. */
  async publishArtifact(title, html) {
    const form = new FormData()
    form.set("file", new Blob([html], { type: "text/html" }), "chart.html")
    form.set("title", title)
    form.set("visibility", "org")
    const res = await fetch(`${this.server}/v1/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
      // Longer than call()'s bound: this can be a 2MB upload on a slow uplink.
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`publish → ${res.status}: ${await res.text()}`)
    return res.json()
  }
}

// ---- repo pointers --------------------------------------------------------------

/** Split a manifest into its body (the system prompt) and the repo pointers in
 *  its frontmatter. Pointers live INSIDE the manifest on purpose: they version
 *  with the judgment they support, and a bare `runner serve <ctx>` on a fresh
 *  box learns them from the server — nothing has to exist on disk first.
 *  Deliberately narrow: only the `repos:` list is read (url required; ref and
 *  description optional); everything else in the frontmatter is ignored, and a
 *  manifest without frontmatter passes through untouched. */
export function parseManifest(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { body: md, repos: [], skills: [], brandprint: "live" }
  const unquote = (v) => {
    const t = v.trim()
    const q = t[0]
    return t.length >= 2 && (q === '"' || q === "'") && t.at(-1) === q ? t.slice(1, -1) : t
  }
  const repos = []
  const skills = []
  // Which list a `- item:` line belongs to; a top-level key line closes both.
  let into = null // "repos" | "skills" | null
  let cur = null
  let brandprint = "live" // ambient workspace conventions on by default
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (/^repos:\s*$/.test(line)) {
      into = "repos"
      continue
    }
    if (/^skills:\s*$/.test(line)) {
      into = "skills"
      continue
    }
    // A top-level scalar: `brandprint: off` opts a context out of the ambient layer.
    const bp = line.match(/^brandprint:\s*(\S+)/)
    if (bp) {
      into = null
      brandprint = unquote(bp[1]) === "off" ? "off" : "live"
      continue
    }
    if (into && /^\S/.test(line)) into = null // next top-level key
    if (!into) continue
    const item = line.match(/^\s*-\s+(\w+):\s*(.+)$/)
    const kv = line.match(/^\s+(\w+):\s*(.+)$/)
    if (item) {
      cur = { [item[1]]: unquote(item[2]) }
      ;(into === "repos" ? repos : skills).push(cur)
    } else if (kv && cur) cur[kv[1]] = unquote(kv[2])
  }
  return {
    body: md.slice(m[0].length),
    repos: repos
      .filter(
        (r) => typeof r.url === "string" && /^(https:\/\/|ssh:\/\/|git@|file:\/\/)/.test(r.url),
      )
      .map((r) => ({ url: r.url, ref: r.ref ?? null, description: r.description ?? "" })),
    // A skill needs an id; version is pinned by `derive context push`, but tolerate a
    // hand-written manifest with none (current is fetched, logged unpinned).
    skills: skills
      .filter((s) => typeof s.id === "string" && s.id)
      .map((s) => ({
        id: s.id,
        version: Number.isFinite(Number(s.version)) ? Number(s.version) : null,
      })),
    brandprint,
  }
}

/** Directory name for a cloned pointer: the last two URL segments (owner-repo),
 *  so same-named repos from different owners don't collide. */
export const repoSlug = (url) => {
  const segs = url
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .filter(Boolean)
  return segs
    .slice(-2)
    .join("-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
}

const git = (args, timeout = 300_000) =>
  new Promise((resolve) => {
    const p = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], timeout })
    let out = ""
    let err = ""
    p.stdout.on("data", (b) => {
      out += b
    })
    p.stderr.on("data", (b) => {
      err += b
    })
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }))
    p.on("error", (e) => resolve({ code: -1, out: "", err: String(e) }))
  })

/** Clone or update each pointer into `<cwd>/repos/<slug>` (shallow, detached at
 *  the ref's tip) and return the catalog with resolved SHAs. Boot-time only —
 *  a manifest edit that adds a repo applies on the next start, like every other
 *  piece of host state. A failed pointer is loud but NON-fatal: the runner
 *  still answers, the catalog marks the repo unavailable so the model can say
 *  so, and private-repo auth rides whatever git already has on this host
 *  (gh auth, ssh keys, GH_TOKEN credential helper). */
export async function syncRepos(repos, cwd) {
  const catalog = []
  for (const r of repos) {
    const dir = join(cwd, "repos", repoSlug(r.url))
    let res
    if (existsSync(join(dir, ".git"))) {
      res = await git(["-C", dir, "fetch", "--depth", "1", "origin", ...(r.ref ? [r.ref] : [])])
      if (res.code === 0) res = await git(["-C", dir, "checkout", "-q", "--detach", "FETCH_HEAD"])
    } else {
      // Same "loud but non-fatal" contract as a failed clone. An unwritable cwd
      // (bind-mount owner vs container uid) used to throw HERE, before the
      // handling below — taking the whole daemon down at boot, on repeat, under
      // restart:unless-stopped. A runner with no repos still answers.
      try {
        mkdirSync(dirname(dir), { recursive: true })
      } catch (e) {
        console.error(`[runner] repo ${r.url}: cannot create ${dirname(dir)} — ${e.message}`)
        catalog.push({ ...r, dir, sha: null })
        continue
      }
      res = await git(["clone", "--depth", "1", ...(r.ref ? ["--branch", r.ref] : []), r.url, dir])
    }
    if (res.code !== 0) {
      console.error(`[runner] repo ${r.url}: ${res.err.slice(0, 200) || "git failed"}`)
      catalog.push({ ...r, dir, sha: null })
      continue
    }
    const sha = await git(["-C", dir, "rev-parse", "--short=12", "HEAD"])
    catalog.push({ ...r, dir, sha: sha.code === 0 ? sha.out : null })
    console.log(`[runner] repo ${repoSlug(r.url)} @ ${sha.out} (${r.ref ?? "default branch"})`)
  }
  return catalog
}

/** Can the runner actually WRITE here? `statSync` proves the cwd exists, which
 *  is not the same thing: the runner clones repos, materializes skills, and now
 *  reads back artifact files under it. Returns null when writable, else the
 *  reason — so doctor reports rather than throws. */
export function checkWritable(dir) {
  let probe
  try {
    // mkdtemp, not a pid-named dir: a probe leaked by a killed doctor (pid 1 in
    // a fresh container, every time) would make the NEXT run report EEXIST on a
    // perfectly writable directory — a health check that fails once and then
    // fails forever.
    probe = mkdtempSync(join(dir, ".derive-probe-"))
    return null
  } catch (e) {
    return e.message
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true })
  }
}

/** The prompt block that tells the model what's on disk and at which SHA. An
 *  unavailable repo is stated outright — a silent gap would read as "the
 *  corpus has nothing on this", which is a wrong answer, not a missing one. */
export function repoCatalogBlock(catalog) {
  if (catalog.length === 0) return ""
  const lines = catalog.map((r) => {
    const rel = `repos/${repoSlug(r.url)}`
    return r.sha
      ? `- ${rel} — ${r.description || r.url} (${r.ref ?? "default"} @ ${r.sha})`
      : `- ${rel} — ${r.description || r.url} — UNAVAILABLE this run (clone failed); say so when an answer would need it`
  })
  return `\n\n## Repositories (cloned into your working directory)\n\n${lines.join("\n")}`
}

// ---- Claude subprocess ---------------------------------------------------------

// The model's output contract. Appended after the manifest so a context author
// can't accidentally break the parse contract by editing their manifest.
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
 *  failed session. */
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

/** Produce a validated answer from one agent run, robustly and provider-agnostically:
 *   1. run -> a parseable <answer> counts EVEN IF the process exited nonzero after
 *      emitting it; the block is the contract, the exit code is a hint.
 *   2. the service failed (provider.retryable)? retry ONCE, resuming the session
 *      when the provider gave one so minutes of tool calls aren't paid for twice.
 *   3. still nothing, and it's an ERROR run? fail -- its text is the API's error
 *      message, and posting "API Error: 529" as an answer is worse than failing.
 *   4. a clean exit with no block, and a session to resume? nudge-retry -- a model
 *      deep in a build often just forgets the block; reformatting is cheap.
 *   5. still no block but substantive output? SALVAGE it with a caveat.
 *  The retry borrows the FIRST run's unspent budget rather than a fresh full one,
 *  so a wedged session can't stall the (strictly sequential) queue for double the
 *  timeout. The runner appends its <answer> contract to the system prompt here, so
 *  every provider is judged against the same output shape. */
export async function runAgent(provider, opts) {
  const systemPrompt = opts.systemPrompt + OUTPUT_CONTRACT
  const base = {
    bin: opts.bin,
    cwd: opts.cwd,
    model: opts.model,
    systemPrompt,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
  }
  // An API failure's message arrives in the result text, a crash's in the last
  // assistant words, a spawn failure's on stderr. Try all three before reporting
  // the bare `exit 1: ` an owner used to get.
  const why = (x) => (x.lastText || x.resultText || x.stderr || "").replace(/\s+/g, " ").trim()
  const started = Date.now()
  let r = await provider.run({ ...base, prompt: opts.prompt, resumeSessionId: null })
  let parsed = parseAnswer(r.resultText)

  // The service failed and gave us nothing usable. One retry -- resumed if the run
  // got a session id, otherwise from the top.
  if (!parsed.answer && provider.retryable(r)) {
    const sid = r.sessionId
    console.error(
      `[runner] run exited ${r.code}${r.apiErrorStatus ? ` (api ${r.apiErrorStatus})` : ""}: ${why(r).slice(0, 160) || "no output"} -- retrying once${sid ? ` (resume ${sid.slice(0, 8)})` : ""}`,
    )
    await new Promise((res) => setTimeout(res, opts.retryDelayMs ?? RETRY_DELAY_MS))
    // Whatever the first attempt didn't spend, floored so a late failure still
    // gets a usable window. The queue is sequential: an unbounded second run
    // would stall every other asker for double the timeout.
    const left = opts.timeoutMs - (Date.now() - started)
    r = await provider.run({
      ...base,
      timeoutMs: Math.max(left, 120_000),
      prompt: sid ? RESUME_PROMPT : opts.prompt,
      resumeSessionId: sid,
    })
    parsed = parseAnswer(r.resultText)
  }

  // A block is a valid answer however the process exited -- the model did the work
  // and said so in the contract's own words.
  if (parsed.answer) return { ok: true, answer: parsed.answer }
  if (r.timedOut) return { ok: false, error: "timed out" }
  // An error run's text is the API's error message, not an answer: fail rather
  // than let the salvage path post "API Error: 529" to the asker.
  if (r.code !== 0 || r.isError)
    return { ok: false, error: `exit ${r.code}: ${why(r).slice(0, 500)}` }

  // Nudge-retry on the same session (bounded -- this is a reformat, not new work).
  if (r.sessionId) {
    console.log(`[runner] no <answer> block; nudging (resume ${r.sessionId.slice(0, 8)})`)
    const r2 = await provider.run({
      ...base,
      timeoutMs: Math.min(opts.timeoutMs, 180_000),
      prompt: NUDGE_PROMPT,
      resumeSessionId: r.sessionId,
    })
    const p2 = parseAnswer(r2.resultText)
    if (p2.answer) return { ok: true, answer: p2.answer }
  }

  // Salvage: real output but never the block. Post the raw reply rather than lose
  // the work -- flagged so the number/prose is read with care.
  const raw = r.resultText.trim()
  if (raw) {
    console.log("[runner] salvaging unstructured reply (no <answer> block after nudge)")
    return {
      ok: true,
      answer: {
        body_md: raw.slice(0, 20_000),
        query: null,
        confidence: null,
        caveats: [
          "The runner couldn't parse a structured answer, so this is the model's raw reply -- treat any figures and confidence with extra care.",
        ],
        escalate: false,
        escalation_reason: null,
        artifact: null,
      },
    }
  }
  return { ok: false, error: parsed.error }
}

/** Back-compat convenience for the default provider; the runClaude tests exercise
 *  the full orchestration through it. New call sites pass a provider to runAgent. */
export const runClaude = (opts) => runAgent(claudeCode, opts)

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

// Exported for tests: this is where a model's answer becomes a posted message —
// artifact resolution, the publish-failure demotion, and the quota cap all live
// here, and all three are things that must not take a session down with them.
export async function serveSession(client, session, manifest, cfg, repoMeta = [], skillMeta = []) {
  const asked = session.messages.at(-1)?.body_md?.slice(0, 80) ?? "?"
  console.log(`[runner] session ${session.id}: "${asked}"`)
  // Whose plan pays for THIS answer: the session's asker (the server resolves it,
  // falling back to the registrant), composed as a per-spawn overlay so nothing
  // sticks to process.env between sessions with different askers. A fail-closed
  // resolve (no plan, no ambient) fails THIS session server-side like any other
  // run failure — thrown, it would leave the claim dangling and retry-loop.
  let modelEnv = null
  if (!cfg.mock) {
    try {
      modelEnv = await resolveModelEnv(cfg, client, session.id)
    } catch (err) {
      console.error(`[runner] session ${session.id} failed: ${err.message}`)
      await client.fail(session.id)
      return
    }
  }
  const result = cfg.mock
    ? { ok: true, answer: MOCK_ANSWER }
    : await runAgent(selectProvider(cfg.providerName), {
        bin: cfg.agentBin,
        cwd: cfg.cwd,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        systemPrompt: manifest,
        prompt: buildPrompt(session.messages),
        env: modelEnv ? { ...process.env, ...modelEnv } : undefined,
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
    // Provenance: which corpus tips this answer was computed against — the
    // difference between "the data says X" and "the data as of ab12cd3 says X".
    ...(repoMeta.length ? { repos: repoMeta } : {}),
    // And which skill versions were on disk for this run (the ambient Brandprint
    // layer is live-at-boot, so its versions are only knowable per-run).
    ...(skillMeta.length ? { skills: skillMeta } : {}),
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
      // Inline or a file under cwd — a bad path reads as a publish failure, so
      // the prose answer still lands with the reason attached.
      const src = resolveArtifactHtml(a.artifact, cfg.cwd)
      if (src.error) throw new Error(src.error)
      const pub = await client.publishArtifact(a.artifact.title, src.html)
      meta.artifacts = [{ short_id: pub.short_id, title: a.artifact.title }]
      // Name the FILE, not just the model's chosen title: bytes published from
      // disk never pass through the event stream, so without this the host log
      // records only a title the model wrote — no record of what was actually
      // sent to the workspace.
      console.log(
        `[runner] published artifact ${pub.short_id} ("${a.artifact.title}"` +
          `${a.artifact.path ? ` from ${a.artifact.path}` : ""})`,
      )
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

/** Boot the host state serve/once share: context info, repo corpus, skills,
 *  conventions. Everything here is per-boot truth on purpose (see the comments
 *  inline) — `once` inherits the same freshness contract as a serve restart. */
/** Resolve the model credential a run authenticates with, as a per-spawn ENV OVERLAY —
 *  never a process.env mutation, so one asker's plan token can't leak into the next
 *  asker's session on a shared context. Pass a session id to bill the run's INITIATOR:
 *  the server resolves the session's asker first and falls back to the agent's
 *  registrant (interim until the workspace pool lands). Precedence:
 *    1. the initiator's connected plan (fetched, decrypted, provider-mapped) — overlay it;
 *    2. no connection but an ambient token is set (self-host's single global plan) — null
 *       overlay, the spawn inherits process.env;
 *    3. neither — FAIL CLOSED with a connect-your-plan message (never a shared fallback).
 *  A lookup error (older/self-host server without the endpoint) degrades to the ambient path. */
export async function resolveModelEnv(cfg, client, sessionId = null) {
  if (cfg.mock) return null
  const provider = selectProvider(cfg.providerName)
  let cred = null
  try {
    cred = await client.modelCredential(cfg.providerName, sessionId)
  } catch (e) {
    console.error(`[runner] model-credential lookup failed (${e.message}); using ambient env`)
    return null
  }
  if (cred) {
    const env = provider.credentialEnv?.(cred.kind, cred.value)
    if (!env)
      throw new Error(
        `the connected ${cfg.providerName} credential (${cred.kind}) can't be injected — connect an API key, or use a provider that supports it`,
      )
    return env
  }
  const ambient = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].some(
    (k) => process.env[k],
  )
  if (!ambient)
    throw new Error(
      `no model plan connected for this run's initiator — connect one at ${cfg.server} (Settings → Model plans)`,
    )
  return null
}

async function bootHost(cfg, modeLabel) {
  const client = new DeriveClient(cfg.server, cfg.token)
  // Preflight only, and non-fatal. With per-initiator billing each session resolves and
  // fails closed on its own (line ~707), so a host legitimately boots with no DEFAULT plan
  // — owner-lend off, no workspace pool, no ambient token — and still serves askers who
  // bring their own. Surface the gap in the log; don't block startup on it. The overlay is
  // discarded regardless: each session resolves its own initiator's credential.
  try {
    await resolveModelEnv(cfg, client)
  } catch (e) {
    console.error(
      `[runner] no default model plan at boot (${e.message}); sessions resolve per-initiator`,
    )
  }
  const info = await client.getContext(cfg.contextId)
  if (!info.manifest_md && !cfg.manifestFile) throw new Error("context has no readable manifest")
  const readManifest = () =>
    cfg.manifestFile ? readFileSync(cfg.manifestFile, "utf8") : (info.manifest_md ?? "")
  const boot = parseManifest(readManifest()) // throws on a bad manifestFile — at startup, not first answer
  console.log(
    `[runner] serving "${info.name}" (${cfg.contextId}) on ${cfg.server} — ` +
      `${cfg.manifestFile ? `manifest LOCAL ${cfg.manifestFile}` : `manifest v${info.manifest_version}`}, ` +
      `${cfg.mock ? "MOCK" : `${cfg.providerName}:${cfg.agentBin} (${cfg.model})`}, ${modeLabel}`,
  )
  // Pointers sync at boot, like every other piece of host state — a manifest
  // edit that adds one applies on the next start (the catalog in the prompt is
  // per-boot truth, and mid-run re-clones would change corpus SHAs between
  // answers in the same session).
  const catalog = await syncRepos(boot.repos, cfg.cwd)
  const repoMeta = catalog.filter((r) => r.sha).map((r) => ({ url: r.url, sha: r.sha }))

  // Conventions materialize at boot, like repos: the workspace Brandprint (ambient,
  // unless `brandprint: off`) plus the manifest's own pinned skills. Skills land in
  // .claude/skills/ (the spawned claude auto-discovers them); notes land in brandprint/.
  // The Brandprint rides on the same config fetch as the manifest (info.brandprint) —
  // the runner's only window into workspace settings.
  const api = client.skillApi()
  const bp = boot.brandprint !== "off" ? (info.brandprint ?? null) : null
  const bpSkills = (bp?.members ?? [])
    .filter((mbr) => mbr.is_skill)
    .map((mbr) => ({ id: mbr.short_id, version: mbr.version }))
  const bpNotes = (bp?.members ?? [])
    .filter((mbr) => !mbr.is_skill)
    .map((mbr) => ({ short_id: mbr.short_id, title: mbr.title, version: mbr.version }))
  // Dedup across the two layers: a skill named in BOTH the ambient Brandprint and the
  // manifest's own `skills:` materializes ONCE (manifest pin wins), never twice under a
  // collided dir.
  const skillCatalog = await materializeSkills(
    api,
    mergeSkillLayers(bpSkills, boot.skills),
    join(cfg.cwd, ".claude", "skills"),
  )
  const noteCatalog = await materializeNotes(api, bpNotes, join(cfg.cwd, "brandprint"))
  const conventions = conventionsBlock(skillCatalog, noteCatalog)
  // Provenance, alongside the repo SHAs: which skill versions this run had on disk.
  const skillMeta = skillCatalog.filter((s) => s.ok).map((s) => ({ id: s.id, version: s.version }))
  return { client, info, catalog, repoMeta, conventions, skillMeta }
}

/** One queue pass: fetch open sessions, serve each sequentially. Throws on a
 *  queue/manifest fetch failure (the caller decides whether that is a logged
 *  poll error or a failed drain); a single session's failure is recorded
 *  server-side via fail() and counted, never thrown — same isolation the serve
 *  loop always had. Returns {considered, served, failed}. */
export async function drainPass(cfg, host) {
  const { client, info, catalog, repoMeta, conventions, skillMeta } = host
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
  const counts = { considered: sessions.length, served: 0, failed: 0 }
  if (sessions.length === 0) return counts
  // Re-read the manifest only when the queue has work — an edit applies
  // from the next answer, and idle polls stay one call. In dev mode the
  // working-tree file wins, same freshness contract. The repo catalog is
  // appended from the BOOT sync — the frontmatter may promise new repos,
  // but the prompt only ever claims what's actually on disk.
  const md = cfg.manifestFile
    ? readFileSync(cfg.manifestFile, "utf8")
    : ((await client.getContext(cfg.contextId)).manifest_md ?? info.manifest_md ?? "")
  const manifest = parseManifest(md).body + repoCatalogBlock(catalog) + conventions
  // Sequential on purpose: one runner, one model, no fan-out — fairness
  // comes from the queue's oldest-first order. One session's failure must
  // not starve the rest of the batch.
  for (const s of sessions) {
    try {
      await serveSession(client, s, manifest, cfg, repoMeta, skillMeta)
      counts.served += 1
    } catch (err) {
      counts.failed += 1
      console.error(`[runner] session ${s.id}: ${err.message}`)
    }
  }
  return counts
}

export async function serve(cfg) {
  const host = await bootHost(cfg, `poll ${cfg.pollMs}ms`)
  for (;;) {
    try {
      await drainPass(cfg, host)
    } catch (err) {
      console.error(`[runner] poll error: ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs))
  }
}

/** Drain the queue once and exit: the executor mode. Any scheduler — a pg-boss
 *  dispatcher, a GitHub Actions cron, a systemd timer — becomes a standing
 *  process by running this on a cadence. Boot or queue failures throw (the
 *  scheduler's retry is the retry); per-session failures are already recorded
 *  server-side, so they end the run quietly with a nonzero `failed` count. */
export async function once(cfg) {
  const host = await bootHost(cfg, "single drain")
  const counts = await drainPass(cfg, host)
  console.log(
    `[runner] drain complete — ${counts.served} served, ${counts.failed} failed, ${counts.considered} considered`,
  )
  return counts
}

// ---- doctor ---------------------------------------------------------------------

/** Preflight the runner's environment; returns the number of hard failures.
 *  Each check maps to a way a runner has actually broken: a wrong/rotated
 *  token, a deleted manifest, launchd's bare PATH (`spawn claude ENOENT`), a
 *  cwd that doesn't exist (same ENOENT, misattributed to the binary). Every
 *  probe is timeboxed — a wedged binary or blackholed host fails its check
 *  instead of hanging the doctor. */
export async function doctor(cfg) {
  let failures = 0
  const ok = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`)
  const bad = (label, detail) => {
    console.error(`  ✖ ${label} — ${detail}`)
    failures++
  }
  const warn = (label, detail) => console.warn(`  ⚠ ${label} — ${detail}`)
  const spawnable = (bin, timeout = 10_000) =>
    new Promise((resolve) => {
      const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout })
      let out = ""
      p.stdout.on("data", (b) => {
        out += b
      })
      p.on("close", (code) => resolve(code === 0 ? out.trim() : null))
      p.on("error", () => resolve(null))
    })

  try {
    const res = await fetch(`${cfg.server}/healthz`, { signal: AbortSignal.timeout(10_000) })
    res.ok ? ok("server reachable", cfg.server) : bad("server", `${cfg.server} → ${res.status}`)
  } catch (e) {
    bad("server", `${cfg.server} unreachable (${e.message})`)
  }

  let repos = []
  let skills = []
  if (!cfg.token || !cfg.contextId) {
    // Partial config: still worth running the local checks below.
    bad(
      "token/context",
      "missing — pass <ctx_id> and --token|--token-file (or DERIVE_CONTEXT + DERIVE_TOKEN)",
    )
  } else {
    try {
      const info = await new DeriveClient(cfg.server, cfg.token).getContext(cfg.contextId)
      info.manifest_md
        ? ok("context + manifest", `"${info.name}" manifest v${info.manifest_version}`)
        : bad("manifest", "context resolves but its manifest is unreadable")
      const parsedManifest = parseManifest(info.manifest_md ?? "")
      repos = parsedManifest.repos
      skills = parsedManifest.skills
    } catch (e) {
      bad("token/context", `cannot resolve ${cfg.contextId} (${e.message.slice(0, 120)})`)
    }
  }

  // Each pointer is probed without cloning — a typo'd URL or missing repo auth
  // should fail here, not at the first boot on a fresh box.
  for (const r of repos) {
    const probe = await git(
      ["ls-remote", "--heads", "--tags", r.url, ...(r.ref ? [r.ref] : [])],
      30_000,
    )
    if (probe.code !== 0) bad(`repo ${repoSlug(r.url)}`, probe.err.slice(0, 120) || "unreachable")
    else if (r.ref && !probe.out) bad(`repo ${repoSlug(r.url)}`, `ref "${r.ref}" not found`)
    else ok(`repo ${repoSlug(r.url)}`, r.ref ?? "default branch")
  }

  // A missing cwd makes spawn fail with the same ENOENT as a missing binary —
  // check it separately so the error points at the actual problem. And EXISTS
  // is not ENOUGH: the runner clones repos, materializes skills, and reads back
  // artifact files here. A read-only cwd passed doctor while serve crash-looped
  // on it — the check has to be the same one serve makes.
  let isDir = false
  try {
    isDir = statSync(cfg.cwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) bad("cwd", `${cfg.cwd} is not a directory — check --cwd / RUNNER_CWD`)
  else {
    const why = checkWritable(cfg.cwd)
    // Fatal only when this context actually needs to write: repos and skills
    // materialize into cwd, and their absence is a WRONG answer, not a missing
    // one. Without either, an unwritable cwd is survivable (the model keeps its
    // scratch in /tmp), so it's a warning — doctor must not refuse to start a
    // deployment that serves correctly, now that a failed clone is non-fatal.
    const needsWrite = repos.length > 0 || skills.length > 0
    const detail =
      `${cfg.cwd} — ${why}. A bind-mount owned by a different uid than the runner ` +
      "process is the usual cause"
    if (!why) ok("cwd", `${cfg.cwd} (writable)`)
    else if (needsWrite)
      bad("cwd writable", `${detail}; this context's repos/skills cannot materialize`)
    else
      warn("cwd writable", `${detail}; fine while this context clones no repos and pins no skills`)
  }

  // launchd/systemd PATHs don't include shell profile additions — the exact
  // failure mode that produced `spawn claude ENOENT` in the field. An unknown
  // provider is a finding here, not a throw (doctor must survive a bad config).
  const provider = PROVIDERS[cfg.providerName]
  if (!provider)
    bad("provider", `unknown "${cfg.providerName}" — known: ${Object.keys(PROVIDERS).join(", ")}`)
  else {
    const version = await provider.version(cfg.agentBin)
    version
      ? ok(cfg.providerName, `${cfg.agentBin} (${version.slice(0, 40)})`)
      : bad(
          cfg.providerName,
          `${cfg.agentBin} not spawnable — pass --agent-bin with an absolute path`,
        )
  }

  for (const tool of ["gh", "python3"]) {
    ;(await spawnable(tool)) !== null
      ? ok(tool)
      : warn(tool, "not on PATH — fine unless this context's manifest needs it")
  }

  console.log(failures === 0 ? "\ndoctor: all checks passed" : `\ndoctor: ${failures} failure(s)`)
  return failures
}

// ---- install ---------------------------------------------------------------------

// systemd unquoted arguments end at whitespace, `%` starts a specifier, and `"`
// needs backslash-escaping inside quotes.
const execArg = (a) => {
  const s = String(a).replace(/%/g, "%%")
  return /[\s"']/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s
}

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
    "--provider",
    cfg.providerName,
    "--agent-bin",
    cfg.agentBin,
    "--model",
    cfg.model,
    "--timeout",
    String(cfg.timeoutMs),
    "--poll",
    String(cfg.pollMs),
  ]
  if (cfg.tokenFile) argv.push("--token-file", cfg.tokenFile)
  if (cfg.envFiles?.length) argv.push("--env-file", cfg.envFiles.join(","))
  if (cfg.manifestFile) argv.push("--manifest-file", cfg.manifestFile)
  if (platform === "darwin") {
    // Paths with &, <, > (think "/Users/x/R&D") would render a plist launchctl
    // rejects outright.
    const escXml = (s) =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const xml = argv.map((a) => `    <string>${escXml(a)}</string>`).join("\n")
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
ExecStart=${argv.map(execArg).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`,
  }
}
