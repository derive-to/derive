// The agent runner: `derive runner serve --agent <id>`. It works one agent's jobs on this
// machine (the agent's `owner` machine): pull claims queued jobs, the model does each one in
// `--cwd`, report settles it. The server owns every policy: which jobs are due, the lease, the
// retry budget, whose model account pays. This loop only does the work and says how it went.
//
// Two rules keep a job from getting two answers. Every report echoes the claim's `started_at`,
// so a report from a claim the server already handed to another runner is refused. And a long
// job reports `progress` at a third of its lease, which renews the lease; a runner that stops
// ticking (a closed laptop) loses the job to the server's reclaim instead of holding it forever.

import { spawn } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { checkpointConversation, latestSessionId, restoreConversation } from "./conversation.js"
import { RUNNER_PROTOCOL_VERSION, SESSION_RESUME } from "./conversation-format.js"
import { selectProvider } from "./providers/index.js"
import { terminateProcess } from "./providers/process.js"
import { prepareRepo, pullRequestFor } from "./repo.js"
import {
  buildPrompt,
  DeriveClient,
  resolveArtifactHtml,
  runAgent,
  stripModelTokens,
  toMicroUsd,
} from "./runner.js"
import { runSession } from "./session.js"
import { fetchSkill, writeSkill } from "./skills.js"

const positiveMs = (raw, fallback, floor) => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= floor ? n : fallback
}

/** Flags win over env, like every runner verb. */
export function loadJobRunnerConfig(env = process.env, flags = {}) {
  const agentId = flags.agent ?? env.DERIVE_AGENT ?? ""
  // --token-file keeps the key out of the process list and shell history.
  const tokenFile = flags["token-file"] ?? env.DERIVE_TOKEN_FILE ?? null
  let token = flags.token ?? ""
  if (!token && tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8").trim()
    } catch (e) {
      throw new Error(`--token-file ${tokenFile}: ${e.code ?? e.message}`)
    }
  }
  if (!token) token = env.DERIVE_TOKEN ?? ""
  if (!agentId || !token)
    throw new Error(
      "an agent id and its key are required (--agent with DERIVE_TOKEN, --token-file, or --token)",
    )
  return {
    server: (flags.server ?? env.DERIVE_SERVER ?? "https://derive.to").replace(/\/+$/, ""),
    token,
    agentId,
    cwd: flags.cwd ?? env.RUNNER_CWD ?? process.cwd(),
    // The agent's own provider and model come with each job; these only override them.
    providerName: flags.provider ?? env.RUNNER_PROVIDER ?? null,
    model: flags.model ?? env.RUNNER_MODEL ?? null,
    agentBin: flags["claude-bin"] ?? flags["agent-bin"] ?? null,
    timeoutMs: positiveMs(flags.timeout ?? env.RUNNER_TIMEOUT_MS, 600_000, 10_000),
    pollMs: positiveMs(flags.poll ?? env.RUNNER_POLL_MS, 5_000, 500),
    mock: flags.mock === "true" || env.RUNNER_MOCK === "1",
    // Fall back to this machine's own model login when the agent has no stored account.
    // `--no-local-login` (or RUNNER_LOCAL_LOGIN=0) requires a stored account instead.
    localLogin: flags["no-local-login"] !== "true" && env.RUNNER_LOCAL_LOGIN !== "0",
  }
}

export class JobClient {
  constructor(cfg, fetchImpl = globalThis.fetch) {
    this.cfg = cfg
    this.fetch = fetchImpl
  }

  async req(path, { method = "GET", body, claim } = {}) {
    const headers = { authorization: `Bearer ${this.cfg.token}` }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (claim) headers["x-derive-claim"] = claim
    const res = await this.fetch(`${this.cfg.server}${path}`, {
      signal: AbortSignal.timeout(20_000),
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    if (!res.ok) {
      const err = new Error(
        `${method} ${path} → ${res.status}: ${parsed?.error ?? text.slice(0, 200)}`,
      )
      err.status = res.status
      // What the server said, for a failure the person reads; the route stays in `message`.
      err.reason = parsed?.error ?? null
      throw err
    }
    return parsed
  }

  /** Stage one image as a workspace asset; returns its permanent URL. */
  async uploadAsset(bytes, type) {
    const res = await this.fetch(`${this.cfg.server}/v1/assets`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": type },
      body: bytes,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || typeof body.url !== "string")
      throw new Error(`image upload failed (${res.status})`)
    return body.url
  }

  /** Publish a new page through the ordinary publish route, as the agent. `access` sets a new
   *  page's sharing (workspace_access, link_role, listed); a new version never changes it. */
  async publish({ title, filename, type, body, shortId, access }) {
    const form = new FormData()
    form.set("file", new Blob([body], { type }), filename)
    if (!shortId) {
      form.set("title", title)
      for (const [k, v] of Object.entries(access ?? {})) form.set(k, v)
    }
    const res = await this.fetch(
      `${this.cfg.server}/v1/artifacts${shortId ? `/${encodeURIComponent(shortId)}/versions` : ""}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}` },
        body: form,
      },
    )
    if (!res.ok) throw new Error(`publish → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }

  pull(limit = 10) {
    return this.req(`/v1/agents/${this.cfg.agentId}/pull`, { method: "POST", body: { limit } })
  }

  async report(job, body) {
    const payload = { started_at: job.started_at, ...body }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.req(`/v1/jobs/${job.id}/report`, { method: "POST", body: payload })
      } catch (error) {
        if (body.status === "progress" || (error.status && error.status < 500) || attempt >= 2)
          throw error
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
      }
    }
  }

  account(job, provider) {
    return this.req(`/v1/jobs/${job.id}/account?provider=${encodeURIComponent(provider)}`, {
      claim: job.started_at,
    })
  }

  refreshAccount(job, body) {
    return this.req(`/v1/jobs/${job.id}/account`, {
      method: "POST",
      body,
      claim: job.started_at,
    })
  }

  environment(job) {
    return this.req(`/v1/jobs/${job.id}/environment`, { claim: job.started_at })
  }

  /** The task's repository token. A refusal (no GitHub connection for the owner, or GitHub
   *  said no) is the person's to fix, so it fails the turn plainly instead of retrying. */
  git(job) {
    return this.req(`/v1/jobs/${job.id}/git`, { claim: job.started_at }).catch((error) => {
      if (error.status !== 404 && error.status !== 409) throw error
      throw Object.assign(new Error(error.reason ?? error.message), { retryable: false })
    })
  }
}

/** The environment the model inherits: no model tokens from this shell (the job's own account
 *  is layered on), and never the agent's key or server, which would let a prompt pull other
 *  jobs or fetch their credentials. */
const runnerFreeEnv = (env, { keepModelLogin = false } = {}) => {
  const out = keepModelLogin ? { ...env } : stripModelTokens(env)
  for (const k of [
    "DERIVE_TOKEN",
    "DERIVE_TOKEN_FILE",
    "DERIVE_AGENT",
    "DERIVE_SERVER",
    "DERIVE_JOB_ID",
    "DERIVE_TOOL_TOKEN",
    "DERIVE_JOB_CLAIM",
  ])
    delete out[k]
  return out
}

/** The system prompt for one job: the agent's standing instructions, then what this job is,
 *  then the source tools it may call (when the runner wrote a shim for them). */
export function jobSystemPrompt(job, { shim = null } = {}) {
  const parts = []
  if (job.instructions?.body_md) parts.push(job.instructions.body_md.trim())
  else parts.push("You are an agent working for a team in Derive. Do the work you are asked to do.")
  if (job.subject) parts.push(`This job is about: ${JSON.stringify(job.subject)}`)
  if (shim && job.tools?.length) {
    const list = job.tools
      .map(({ def }) => {
        const args = def.params ?? def.input_schema ?? def.inputSchema
        return `- ${def.name}: ${def.description ?? ""}${args ? ` Arguments: ${JSON.stringify(args)}` : ""}`
      })
      .join("\n")
    parts.push(
      `You can use this agent's sources through these tools. Call one by running \`node ${shim} <tool> '<json args>'\` in the shell; it prints the tool's JSON result:\n${list}`,
    )
  }
  // A bound source that gave no tools. Saying so beats letting the model work as though the
  // source was never configured.
  if (job.sources_quiet?.length) {
    const lost = job.sources_quiet.map((q) => `- ${q.toolkit}: ${q.why ?? q.reason}`).join("\n")
    parts.push(
      `These sources are unavailable for this job:\n${lost}\nDo not guess what they would have returned. Do the rest and say plainly which source was missing and why.`,
    )
  }
  return `${parts.join("\n\n")}\n`
}

// The source-tool shim, written into the job's cwd when the job has tools. The model calls a
// source with `node .derive/source-<job>.mjs <tool> '<json args>'`; the shim posts to the job's
// tool route, where the server checks the tool against the agent's sources and runs it. It
// authenticates with the job's tool token (DERIVE_TOOL_TOKEN), which reaches only this job's
// tool route while this claim holds, so the model never holds the runner's own credential.
export const TOOL_SHIM_SRC = `#!/usr/bin/env node
const env = process.env
const [tool, argsJson] = process.argv.slice(2)
if (!tool) {
  console.error("usage: node <shim> <tool> '<json args>'")
  process.exit(2)
}
let args = {}
if (argsJson) {
  try {
    args = JSON.parse(argsJson)
  } catch (e) {
    console.error("args must be JSON: " + e.message)
    process.exit(2)
  }
}
const url = env.DERIVE_SERVER + "/v1/jobs/" + encodeURIComponent(env.DERIVE_JOB_ID) + "/tool"
const res = await fetch(url, {
  method: "POST",
  headers: {
    authorization: "Bearer " + env.DERIVE_TOOL_TOKEN,
    "content-type": "application/json",
    "x-derive-claim": env.DERIVE_JOB_CLAIM,
  },
  body: JSON.stringify({ tool, args }),
})
const text = await res.text()
if (!res.ok) {
  console.error("tool " + tool + " failed (" + res.status + "): " + text.slice(0, 1000))
  process.exit(1)
}
try {
  console.log(JSON.stringify(JSON.parse(text).result))
} catch {
  console.log(text)
}
`

/** Write the shim for one job (concurrent jobs share a cwd, so each gets its own file) and
 *  return its path relative to cwd, plus its cleanup. */
function writeToolShim(cwd, job) {
  const dir = join(cwd, ".derive")
  const rel = `.derive/source-${job.id}.mjs`
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(cwd, rel), TOOL_SHIM_SRC, { mode: 0o755 })
  return {
    rel,
    cleanup: () => {
      try {
        rmSync(join(cwd, rel), { force: true })
        rmdirSync(dir) // only when empty: the directory may hold other things
      } catch {}
    },
  }
}

/** A private folder for one job's secrets. A cloud stop can interrupt `finally` before the
 *  provider saves the disk, so on a Derive machine it lives on tmpfs, which a saved disk
 *  cannot retain. */
function privateDir(prefix) {
  let root = tmpdir()
  if (process.env.DERIVE_RUNNER_ISOLATED === "1") {
    try {
      if (statfsSync("/dev/shm").type !== 0x01021994) throw new Error("not tmpfs")
      root = "/dev/shm"
    } catch {
      throw Object.assign(new Error("Cloud login files require memory-backed /dev/shm storage"), {
        retryable: false,
      })
    }
  }
  return mkdtempSync(join(root, prefix))
}

/** The model credential for this job as a per-spawn env overlay, plus its cleanup. Throws with
 *  a sentence a person can act on when nothing is connected. */
async function modelEnvFor(
  client,
  job,
  provider,
  providerName,
  server,
  { localLogin = false } = {},
) {
  const res = await client.account(job, providerName)
  // On a person's own machine, a job with no stored account runs on whatever login the model's
  // CLI already has there (claude or codex signed in, or a key in this shell). A stored account
  // that cannot be read is still an error: someone meant that account to pay.
  if (!res?.credential && localLogin && res?.reason !== "unreadable")
    return { env: {}, cleanup: () => {}, local: true }
  if (!res?.credential)
    throw Object.assign(
      new Error(
        res?.reason === "unreadable"
          ? `the ${providerName} account for this agent couldn't be read. Reconnect it at ${server}`
          : `no ${providerName} account for this agent. Connect one on the agent's Settings tab at ${server}`,
      ),
      { retryable: false },
    )
  const env = provider.credentialEnv?.(res.credential.kind, res.credential.value)
  const spec = provider.credentialFiles?.(res.credential.kind, res.credential.value)
  if (!spec && !env)
    throw Object.assign(new Error(`can't use a ${res.credential.kind} credential here`), {
      retryable: false,
    })
  const dir = privateDir("derive-cred-")
  for (const [name, content] of Object.entries(spec?.files ?? {}))
    writeFileSync(join(dir, name), content, { mode: 0o600 })
  return {
    home: dir,
    env: {
      ...env,
      [spec?.homeEnv ?? (providerName === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR")]: dir,
    },
    flush: async () => {
      if (providerName !== "codex" || res.credential.kind !== "login" || !res.account_id) return
      try {
        const next = readFileSync(join(dir, "auth.json"), "utf8")
        if (next !== res.credential.value)
          await client.refreshAccount(job, {
            account_id: res.account_id,
            credential_version: res.credential_version,
            secret: next,
          })
      } catch {
        process.stderr.write(
          "[runner] Could not save the refreshed login. Reconnect if your next task needs it.\n",
        )
      }
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(
          `[runner] Could not remove model credential files: ${error.code ?? "unknown error"}\n`,
        )
      }
    },
  }
}

const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}

/** A page's `<img src="shots/a.png">` names a file in the working directory, which no reader
 *  can open. Stage each such image as a workspace asset and point the page at its permanent
 *  URL, so a report can carry real screenshots without inlining megabytes of base64. */
export async function stageLocalImages(client, html, cwd, notes = [], page = ".") {
  const root = realpathSync(cwd)
  // Relative links resolve from the page's own folder, as a browser would.
  const base = dirname(resolve(root, page))
  const staged = new Map()
  for (const [, path] of html.matchAll(/<img\b[^>]*?\ssrc=["']([^"':]+?)["']/gi)) {
    if (staged.has(path) || path.startsWith("/") || path.startsWith("//")) continue
    const type = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""]
    if (!type) continue
    try {
      const full = realpathSync(resolve(base, path))
      if (!full.startsWith(root + sep)) throw new Error("outside the working directory")
      staged.set(path, await client.uploadAsset(readFileSync(full), type))
    } catch (e) {
      notes.push(`Image ${path} could not be attached: ${e.message}`)
    }
  }
  let out = html
  for (const [path, url] of staged)
    out = out.replaceAll(`"${path}"`, `"${url}"`).replaceAll(`'${path}'`, `'${url}'`)
  return out
}

/** One interactive session turn: the native harness in tmux until it exits or idles. A turn
 *  that only reopens the session (`derive attach`) sends no message; any other follow-up is
 *  typed in as the session's next message. */
async function serveSession(
  start,
  { provider, providerName, bin, cwd, model, effort, systemPrompt, turn, env, home, signal, meter },
) {
  const resumeSessionId = turn?.previous?.session_id ?? null
  const prompt = resumeSessionId && turn?.body_md === SESSION_RESUME ? null : turn?.body_md
  const args = provider.sessionArgs({ model, effort, systemPrompt, prompt, resumeSessionId, home })
  provider.prepareSession?.({ home, cwd, env, systemPrompt })
  const ended = await start({ bin, args, cwd, env, signal })
  meter.sessionId = latestSessionId(home, providerName) ?? resumeSessionId
  if (ended === "stopped") return { ok: false, error: "The session was stopped.", retryable: false }
  return {
    ok: true,
    answer: {
      body_md:
        ended === "idle"
          ? "Session paused while idle. `derive attach` picks it up where it left off."
          : "Session ended.",
      escalate: false,
    },
  }
}

const CHECK_TIMEOUT_MS = 10 * 60_000
const GIT_TOKEN_RENEW_MS = 40 * 60_000

/** Run the agent's machine check. A nonzero exit fails the task with the output's tail and
 *  is not retryable: the same machine would fail the same way. Async, so lease ticks continue. */
export async function checkMachine(command, cwd, environment = {}, signal) {
  console.log("[runner] checking the machine")
  let output = ""
  const { code, timedOut } = await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...runnerFreeEnv(process.env), ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const keep = (b) => {
      output = (output + b.toString()).slice(-16_000)
    }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    let late = false
    const stop = () => terminateProcess(child, "SIGKILL")
    const timer = setTimeout(() => {
      late = true
      stop()
    }, CHECK_TIMEOUT_MS)
    signal?.addEventListener("abort", stop, { once: true })
    child.on("error", (e) => {
      keep(String(e))
      resolve({ code: -1, timedOut: false })
    })
    child.on("close", (exit, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      resolve({ code: exit ?? sig, timedOut: late })
    })
  })
  if (code === 0) return
  const tail = output
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))=\S+/g, "$1=[redacted]")
    .trim()
    .split("\n")
    .slice(-30)
    .join("\n")
    .slice(-3_000)
  const how = timedOut ? "timed out" : `exited ${code}`
  throw Object.assign(
    new Error(
      `The machine is not ready: its check ${how}. No model ran.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ""}`,
    ),
    { retryable: false },
  )
}

/** Do one claimed job and report it. Never throws: every failure becomes a report. */
export async function serveJob(client, job, cfg, deps = {}) {
  const began = Date.now()
  const meter = deps.meter ?? { costUsd: null }
  const run = deps.runAgent ?? runAgent
  const providerName = job.turn
    ? job.execution.provider
    : (cfg.providerName ?? (job.execution?.provider === "codex" ? "codex" : "claude-code"))
  const provider = selectProvider(providerName)
  const model = job.turn
    ? (job.execution.model ?? provider.defaultModel)
    : (cfg.model ?? job.execution?.model ?? provider.defaultModel)
  console.log(`[runner] job ${job.id}`)

  // Keep the claim alive while the model works.
  const leaseMs = job.lease_until ? new Date(job.lease_until).getTime() - Date.now() : 0
  const tickEvery = Math.max(5_000, Math.min(15_000, Math.floor(leaseMs / 3)))
  let lost = false
  const abort = new AbortController()
  const events = []
  let eventSeq = 0
  const tick = setInterval(() => {
    client
      .report(job, {
        status: "progress",
        protocol_version: RUNNER_PROTOCOL_VERSION,
        ...(job.turn ? { turn_id: job.turn.id, events: events.slice(-100) } : {}),
      })
      .catch((e) => {
        if (e.status === 409 || e.status === 401 || e.status === 403) {
          lost = true
          abort.abort()
        }
      })
  }, tickEvery)
  tick.unref?.()

  let cleanup = () => {}
  let flushCredential = async () => {}
  let shim = null
  let home = null
  let harnessVersion = null
  let git = null
  let gitDir = null
  let renewGit = null
  let checkpoint = null
  let terminal = null
  const report = (body) => {
    const payload = {
      protocol_version: RUNNER_PROTOCOL_VERSION,
      ...(job.turn
        ? {
            turn_id: job.turn.id,
            session_id: meter.sessionId ?? null,
            checkpoint,
            events: events.slice(-100),
          }
        : {}),
      ...body,
    }
    terminal = payload
    return client.report(job, payload)
  }
  try {
    if (job.turn && job.protocol_version !== RUNNER_PROTOCOL_VERSION)
      throw Object.assign(new Error("This task requires another runner protocol."), {
        retryable: false,
      })
    const bin = cfg.agentBin ?? provider.binFrom({}, process.env)
    harnessVersion = cfg.mock ? null : await provider.version(bin)
    if (!cfg.mock && !harnessVersion)
      throw Object.assign(
        new Error(
          "The selected harness is unavailable in this sandbox. Update the sandbox environment.",
        ),
        { retryable: false },
      )
    let env
    if (!cfg.mock) {
      // One after the other, so a credential file written for this job is always cleaned up.
      const { environment = {} } = (await client.environment(job)) ?? {}
      // The task's repository comes first: the check, the harness, and the skill all work in it.
      if (job.execution?.repo) {
        git = await client.git(job)
        // Git reads the token from a private file the runner renews before it expires (about
        // an hour), so a long session can still push and open its pull request.
        gitDir = privateDir("derive-git-")
        const tokenFile = join(gitDir, "token")
        const checkout = prepareRepo(git, {
          cwd: cfg.cwd,
          firstTurn: (job.turn?.ordinal ?? 1) === 1,
          tokenFile,
        })
        renewGit = setInterval(
          () =>
            client
              .git(job)
              .then((next) => {
                writeFileSync(tokenFile, next.token, { mode: 0o600 })
                git = { ...git, token: next.token }
              })
              .catch((error) =>
                console.error(`[runner] could not renew the repository token: ${error.message}`),
              ),
          GIT_TOKEN_RENEW_MS,
        )
        renewGit.unref?.()
        cfg = { ...cfg, cwd: checkout.dir }
        Object.assign(environment, checkout.env)
      }
      // The machine must be ready before a model credential or token is spent on it.
      if (job.execution?.check)
        await (deps.checkMachine ?? checkMachine)(
          job.execution.check,
          cfg.cwd,
          environment,
          abort.signal,
        )
      const cred = await modelEnvFor(client, job, provider, providerName, cfg.server, {
        localLogin: cfg.localLogin,
      })
      cleanup = cred.cleanup
      home = cred.home ?? null
      if (job.turn?.previous) {
        if (!home)
          throw Object.assign(new Error("A private model home is required for continuation."), {
            retryable: false,
          })
        restoreConversation(home, job.turn.previous, providerName)
      }
      if (job.turn?.ordinal > 1 && !job.turn.previous && !job.turn.fresh)
        throw Object.assign(
          new Error("The original conversation checkpoint is unavailable. Start a fresh task."),
          { retryable: false },
        )
      flushCredential = cred.flush ?? flushCredential
      if (job.instructions?.bundle) {
        const skill = await fetchSkill(new DeriveClient(cfg.server, cfg.token).skillApi(), {
          id: job.instructions.short_id,
          version: job.instructions.version,
        })
        const dir = join(cfg.cwd, ".derive", "skills", "instructions")
        writeSkill(join(cfg.cwd, ".derive", "skills"), "instructions", skill.files)
        job.instructions.body_md = `${skill.files.get("SKILL.md").toString()}\n\nSupporting files are in ${dir}.`
      }
      // Source tools: a shim in cwd and exactly what it needs to call this job's tool route.
      // The job's tool token, never the runner's credential: it reaches this job's tool route
      // and nothing else, and dies with the claim.
      let toolEnv = {}
      if (job.tools?.length && job.tool_token) {
        shim = writeToolShim(cfg.cwd, job)
        toolEnv = {
          DERIVE_SERVER: cfg.server,
          DERIVE_JOB_ID: job.id,
          DERIVE_JOB_CLAIM: job.started_at,
          DERIVE_TOOL_TOKEN: job.tool_token,
        }
      }
      env = {
        ...runnerFreeEnv(process.env, { keepModelLogin: cred.local }),
        ...environment,
        ...cred.env,
        ...toolEnv,
      }
    }
    const result = cfg.mock
      ? { ok: true, answer: { body_md: `Mock run of job ${job.id}.`, escalate: false } }
      : job.execution?.session
        ? await serveSession(deps.runSession ?? runSession, {
            provider,
            providerName,
            bin: cfg.agentBin ?? provider.binFrom({}, process.env),
            cwd: cfg.cwd,
            model,
            effort: job.execution.effort ?? null,
            systemPrompt: jobSystemPrompt(job, { shim: shim?.rel }),
            turn: job.turn,
            env,
            home,
            signal: abort.signal,
            meter,
          })
        : await run(provider, {
            bin: cfg.agentBin ?? provider.binFrom({}, process.env),
            cwd: cfg.cwd,
            model,
            effort: job.execution?.effort ?? null,
            timeoutMs: cfg.timeoutMs,
            systemPrompt: jobSystemPrompt(job, { shim: shim?.rel }),
            // A turn with nothing to continue reads the whole exchange so far.
            prompt:
              job.turn && !job.turn.fresh ? job.turn.body_md : buildPrompt(job.messages ?? []),
            resumeSessionId: job.turn?.previous?.session_id ?? null,
            env,
            signal: abort.signal,
            onEvent: (event) => {
              if (eventSeq < 500)
                events.push({
                  seq: ++eventSeq,
                  kind: event.kind,
                  ...(event.label ? { label: String(event.label).slice(0, 160) } : {}),
                })
            },
            meter,
          })
    await flushCredential()
    if (job.turn && meter.sessionId && home) {
      try {
        checkpoint = checkpointConversation(home, providerName, meter.sessionId)
      } catch {
        console.error(
          "[runner] The result is ready, but its conversation checkpoint could not be saved.",
        )
      }
    }
    const cost = toMicroUsd(meter.costUsd)
    const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null)
    const usage = meter.usage ?? {}
    const receipt = {
      runs: [
        {
          attempt: job.attempt ?? 0,
          provider: providerName,
          model,
          runner_version: JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
          ).version,
          harness_version: harnessVersion,
          ...(job.instructions
            ? { skill: { short_id: job.instructions.short_id, version: job.instructions.version } }
            : {}),
          input_tokens: count(usage.input_tokens),
          cached_input_tokens: count(usage.cached_input_tokens ?? usage.cache_read_input_tokens),
          output_tokens: count(usage.output_tokens),
          duration_ms: Date.now() - began,
          model_cost_micro_usd: cost,
          harness_estimate_micro_usd: toMicroUsd(meter.estimatedCostUsd),
        },
      ],
    }
    if (lost) {
      // A stopped claim still reports its measured usage. Settlement cannot reopen it.
      await report({
        status: "failed",
        result: receipt,
        ...(cost !== null ? { cost_micro_usd: cost } : {}),
      }).catch(() => {})
      return "lost"
    }
    if (!result.ok) {
      await report({
        status: "failed",
        body_md: `The run failed: ${result.error}`,
        retryable: !!result.retryable,
        result: receipt,
        ...(cost !== null ? { cost_micro_usd: cost } : {}),
      })
      return "failed"
    }
    const a = result.answer
    // Publish only a useful artifact. The task itself keeps its answer and receipt.
    const made = []
    const flagged = [...(a.caveats ?? [])]
    if (job.turn && !checkpoint)
      flagged.push(
        "This result is ready. Its conversation checkpoint is unavailable, so continuing needs a fresh task.",
      )
    if (a.artifact && !cfg.mock) {
      try {
        const src = resolveArtifactHtml(a.artifact, cfg.cwd)
        if (src.error) throw new Error(src.error)
        const pub = await client.publish({
          title: a.artifact.title,
          filename: "page.html",
          type: "text/html",
          body: await stageLocalImages(client, src.html, cfg.cwd, flagged, a.artifact.path),
        })
        made.push({ title: a.artifact.title, short_id: pub.short_id })
      } catch (e) {
        flagged.push(`The page it made could not be published: ${e.message}`)
      }
    }
    // A turn in a repository reports the pull request its branch has, if any.
    const pr = git && !cfg.mock ? await (deps.pullRequestFor ?? pullRequestFor)(git, cfg.cwd) : null
    const effects = [
      ...made.map((page) => ({ kind: "page", label: page.title, ref: page.short_id })),
      ...(pr ? [pr] : []),
    ]
    const common = {
      result: { ...receipt, ...(effects.length ? { effects } : {}) },
      body_md: [
        a.body_md,
        ...(a.query ? [`Evidence: ${a.query}`] : []),
        ...flagged.map((note) => `Note: ${note}`),
      ].join("\n\n"),
      ...(cost !== null ? { cost_micro_usd: cost } : {}),
    }
    if (a.escalate) {
      await report({
        status: "needs_you",
        ...common,
        needs: {
          kind: "escalation",
          question: a.escalation_reason ?? "This needs a person.",
          ...(a.escalation_options?.length ? { options: a.escalation_options } : {}),
        },
      })
      return "needs_you"
    }
    await report({ status: "succeeded", ...common })
    return "succeeded"
  } catch (e) {
    await flushCredential()
    console.error(`[runner] job ${job.id} failed: ${e.message}`)
    if (terminal) {
      await client.report(job, terminal).catch(() => {})
      return "lost"
    }
    await report({ status: "failed", body_md: e.message, retryable: e.retryable !== false }).catch(
      () => {},
    )
    return "failed"
  } finally {
    clearInterval(tick)
    clearInterval(renewGit)
    if (gitDir) rmSync(gitDir, { recursive: true, force: true })
    cleanup()
    shim?.cleanup()
  }
}

/** One pull and the work it returned, run one at a time (the server already capped the claim
 *  at the agent's concurrency). Returns counts. */
export async function jobDrainPass(cfg, client = new JobClient(cfg)) {
  const { jobs = [] } = (await client.pull()) ?? {}
  const counts = { served: 0, failed: 0, considered: jobs.length }
  await Promise.all(
    jobs.map(async (job) => {
      const out = await serveJob(client, job, cfg, { meter: { costUsd: null } })
      if (out === "failed") counts.failed++
      else counts.served++
    }),
  )
  return counts
}

/** The Derive machine's entry: one `dkjob_` token, one job, then exit. The job is already
 *  claimed server-side; this fetches it, does it, and reports it. */
export function loadOneJobConfig(env = process.env, flags = {}) {
  const token = flags.token ?? env.DERIVE_TOKEN ?? ""
  const jobId = flags.job ?? env.DERIVE_JOB_ID ?? ""
  if (!token.startsWith("dkjob_") || !jobId)
    throw new Error("runner run needs a job token (DERIVE_TOKEN=dkjob_...) and DERIVE_JOB_ID")
  return {
    ...loadJobRunnerConfig(env, { ...flags, token, agent: "from-job" }),
    // A Derive machine has no login of its own; its jobs always run on a stored account.
    localLogin: false,
    jobId,
  }
}

export async function runOneJob(cfg, client = new JobClient(cfg), deps = {}) {
  const { job } = await client.req(
    `/v1/jobs/${encodeURIComponent(cfg.jobId)}/work?protocol_version=${RUNNER_PROTOCOL_VERSION}`,
  )
  return serveJob(
    client,
    job,
    { ...cfg, agentId: job.agent_id },
    { meter: { costUsd: null }, ...deps },
  )
}

export async function serveJobs(cfg) {
  const client = new JobClient(cfg)
  console.log(
    `[runner] agent ${cfg.agentId} on ${cfg.server}, cwd ${cfg.cwd}, poll ${cfg.pollMs}ms`,
  )
  for (;;) {
    try {
      await jobDrainPass(cfg, client)
    } catch (e) {
      if (e.status === 401 || e.status === 403)
        throw new Error(`the server refused this key (${e.message})`)
      console.error(`[runner] poll error: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs))
  }
}
