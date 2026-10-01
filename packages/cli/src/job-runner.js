// The agent runner: `derive runner serve --agent <id>`. It works one agent's jobs on this
// machine (the agent's `owner` machine): pull claims queued jobs, the model does each one in
// `--cwd`, report settles it. The server owns every policy: which jobs are due, the lease, the
// retry budget, whose model account pays. This loop only does the work and says how it went.
//
// Two rules keep a job from getting two answers. Every report echoes the claim's `started_at`,
// so a report from a claim the server already handed to another runner is refused. And a long
// job reports `progress` at a third of its lease, which renews the lease; a runner that stops
// ticking (a closed laptop) loses the job to the server's reclaim instead of holding it forever.
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectProvider } from "./providers/index.js"
import {
  buildPrompt,
  resolveArtifactHtml,
  runAgent,
  stripModelTokens,
  toMicroUsd,
} from "./runner.js"

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
      throw err
    }
    return parsed
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

  /** The job's report page: a new version of the one it already has, or its first. A first
   *  report is private to the workspace (members can open it, no link, listed nowhere): it is
   *  the job's record, found from the job, and sharing it further is a person's choice. */
  publishReport(job, md) {
    return this.publish({
      title: reportTitle(job),
      filename: "report.md",
      type: "text/markdown",
      body: md,
      shortId: job.report_short_id ?? undefined,
      access: REPORT_ACCESS,
    })
  }

  pull(limit = 10) {
    return this.req(`/v1/agents/${this.cfg.agentId}/pull`, { method: "POST", body: { limit } })
  }

  report(job, body) {
    return this.req(`/v1/jobs/${job.id}/report`, {
      method: "POST",
      body: { started_at: job.started_at, ...body },
    })
  }

  account(job, provider) {
    return this.req(`/v1/jobs/${job.id}/account?provider=${encodeURIComponent(provider)}`, {
      claim: job.started_at,
    })
  }

  environment(job) {
    return this.req(`/v1/jobs/${job.id}/environment`, { claim: job.started_at })
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

/** How a job's report page is shared when it is first made. */
const REPORT_ACCESS = { workspace_access: "member", link_role: "none", listed: "none" }

const firstLine = (s) =>
  (s ?? "")
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? ""
const reportTitle = (job) => firstLine(job.instruction).slice(0, 120) || `Job ${job.id}`

/** The report every job leaves: what was asked, what was done, what to look at twice, what it
 *  made, and how it knows. Sections with nothing to say are left out. */
export function reportMarkdown(job, answer, { made = [], flagged = [], cfg = {} } = {}) {
  const asked = [...(job.messages ?? [])].reverse().find((m) => m.author_kind === "asker")?.body_md
  const parts = [
    `# ${reportTitle(job)}`,
    "",
    "## Asked",
    "",
    asked ?? job.instruction ?? "",
    "",
    "## Did",
    "",
    answer.body_md ?? "",
  ]
  if (flagged.length) parts.push("", "## Flagged", "", ...flagged.map((f) => `- ${f}`))
  if (made.length) parts.push("", "## Made", "", ...made.map((m) => `- ${m.title} (${m.short_id})`))
  if (answer.query) parts.push("", "## Evidence", "", "```", answer.query, "```")
  const model = cfg.model ?? job.execution?.model ?? job.execution?.provider ?? ""
  parts.push("", "---", "", `\`${[job.id, model].filter(Boolean).join(" · ")}\``)
  return `${parts.join("\n")}\n`
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
  if (env) return { env, cleanup: () => {} }
  const spec = provider.credentialFiles?.(res.credential.kind, res.credential.value)
  if (!spec)
    throw Object.assign(new Error(`can't use a ${res.credential.kind} credential here`), {
      retryable: false,
    })
  const dir = mkdtempSync(join(tmpdir(), "derive-cred-"))
  for (const [name, content] of Object.entries(spec.files))
    writeFileSync(join(dir, name), content, { mode: 0o600 })
  return {
    env: { [spec.homeEnv]: dir },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

/** Do one claimed job and report it. Never throws: every failure becomes a report. */
export async function serveJob(client, job, cfg, deps = {}) {
  const run = deps.runAgent ?? runAgent
  const providerName =
    cfg.providerName ?? (job.execution?.provider === "codex" ? "codex" : "claude-code")
  const provider = selectProvider(providerName)
  const asked = (job.messages?.at(-1)?.body_md ?? "").slice(0, 80)
  console.log(`[runner] job ${job.id}: "${asked}"`)

  // Keep the claim alive while the model works.
  const leaseMs = job.lease_until ? new Date(job.lease_until).getTime() - Date.now() : 0
  const tickEvery = Math.max(15_000, Math.floor(leaseMs / 3))
  let lost = false
  const tick = setInterval(() => {
    client.report(job, { status: "progress" }).catch((e) => {
      if (e.status === 409) lost = true
    })
  }, tickEvery)
  tick.unref?.()

  let cleanup = () => {}
  let shim = null
  try {
    let env
    if (!cfg.mock) {
      // One after the other, so a credential file written for this job is always cleaned up.
      const { environment = {} } = (await client.environment(job)) ?? {}
      const cred = await modelEnvFor(client, job, provider, providerName, cfg.server, {
        localLogin: cfg.localLogin,
      })
      cleanup = cred.cleanup
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
      : await run(provider, {
          bin: cfg.agentBin ?? provider.binFrom({}, process.env),
          cwd: cfg.cwd,
          model: cfg.model ?? job.execution?.model ?? provider.defaultModel,
          timeoutMs: cfg.timeoutMs,
          systemPrompt: jobSystemPrompt(job, { shim: shim?.rel }),
          prompt: buildPrompt(job.messages ?? []),
          env,
          meter: deps.meter,
        })
    if (lost) {
      console.error(
        `[runner] job ${job.id}: the claim moved to another runner; dropping the answer`,
      )
      return "lost"
    }
    const cost = toMicroUsd(deps.meter?.costUsd)
    if (!result.ok) {
      await client.report(job, {
        status: "failed",
        body_md: `The run failed: ${result.error}`,
        retryable: !!result.retryable,
        ...(cost !== null ? { cost_micro_usd: cost } : {}),
      })
      return "failed"
    }
    const a = result.answer
    // What the answer made (a chart page), then the job's report page. Either failing demotes
    // to a line in the reply: the answer itself still lands.
    const made = []
    const flagged = [...(a.caveats ?? [])]
    if (a.artifact && !cfg.mock) {
      try {
        const src = resolveArtifactHtml(a.artifact, cfg.cwd)
        if (src.error) throw new Error(src.error)
        const pub = await client.publish({
          title: a.artifact.title,
          filename: "page.html",
          type: "text/html",
          body: src.html,
        })
        made.push({ title: a.artifact.title, short_id: pub.short_id })
      } catch (e) {
        flagged.push(`The page it made could not be published: ${e.message}`)
      }
    }
    let report = null
    try {
      report = await client.publishReport(job, reportMarkdown(job, a, { made, flagged, cfg }))
    } catch (e) {
      console.error(`[runner] job ${job.id}: report not published: ${e.message}`)
    }
    const common = {
      body_md: a.body_md,
      ...(report?.short_id ? { report_short_id: report.short_id } : {}),
      ...(cost !== null ? { cost_micro_usd: cost } : {}),
    }
    if (a.escalate) {
      await client.report(job, {
        status: "needs_you",
        ...common,
        needs: { kind: "escalation", question: a.escalation_reason ?? "This needs a person." },
      })
      return "needs_you"
    }
    await client.report(job, { status: "succeeded", ...common })
    return "succeeded"
  } catch (e) {
    console.error(`[runner] job ${job.id} failed: ${e.message}`)
    await client
      .report(job, { status: "failed", body_md: e.message, retryable: e.retryable !== false })
      .catch(() => {})
    return "failed"
  } finally {
    clearInterval(tick)
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
  const { job } = await client.req(`/v1/jobs/${encodeURIComponent(cfg.jobId)}/work`)
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
