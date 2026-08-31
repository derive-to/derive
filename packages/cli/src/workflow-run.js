import { spawn } from "node:child_process"

export const GITHUB_ACTIONS_OIDC_AUDIENCE = "derive-graph-runner"
export const WORKFLOW_TOKEN_ENV = "DERIVE_WORKFLOW_TOKEN"

const DEFAULT_SERVER = "https://derive.to"
const DEFAULT_TIMEOUT_MS = 5 * 60 * 60 * 1_000
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1_000
const RETRY_DELAYS_MS = [0, 250, 1_000]
const SAFE_EVENT_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "plan_update",
  "web_search",
])
const CODEX_DIAGNOSTIC_WINDOW = 8_192

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const validRunId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)

const validNonce = (value) =>
  typeof value === "string" && value.length >= 16 && value.length <= 512 && !/\s/.test(value)

function secureUrl(value, label, { githubActions = false } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error(`${label} must use HTTPS`)
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`)
  if (githubActions && !url.hostname.endsWith(".actions.githubusercontent.com"))
    throw new Error("GitHub Actions did not provide a trusted OIDC endpoint")
  return url
}

export function normalizeWorkflowServer(value = DEFAULT_SERVER) {
  const url = secureUrl(value, "Derive server")
  if (url.search || url.hash) throw new Error("Derive server must not contain a query or fragment")
  return url.toString().replace(/\/+$/, "")
}

export function githubOidcRequest(urlValue) {
  const url = secureUrl(urlValue, "GitHub Actions OIDC endpoint", { githubActions: true })
  url.searchParams.set("audience", GITHUB_ACTIONS_OIDC_AUDIENCE)
  return url.toString()
}

export function workflowExchangeUrl(server, runId) {
  if (!validRunId(runId)) throw new Error("workflow run id is missing or malformed")
  return `${normalizeWorkflowServer(server)}/v1/workflow-runs/${encodeURIComponent(runId)}/github/exchange`
}

async function retryFetch(
  request,
  { fetchImpl, retryDelays = RETRY_DELAYS_MS, sleepImpl = sleep },
) {
  let lastError = null
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) await sleepImpl(retryDelays[attempt])
    try {
      const response = await fetchImpl(request.url, request.init)
      if (response.status !== 429 && response.status < 500) return response
      lastError = new Error(`${request.label} temporarily unavailable (${response.status})`)
    } catch {
      lastError = new Error(`${request.label} could not be reached`)
    }
  }
  throw lastError ?? new Error(`${request.label} could not be reached`)
}

export async function requestGithubOidc({
  requestUrl,
  requestToken,
  fetchImpl = fetch,
  retryDelays,
  sleepImpl,
}) {
  if (typeof requestToken !== "string" || !requestToken.trim())
    throw new Error("GitHub Actions OIDC request token is missing")
  const response = await retryFetch(
    {
      label: "GitHub Actions OIDC endpoint",
      url: githubOidcRequest(requestUrl),
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${requestToken}`,
        },
      },
    },
    { fetchImpl, retryDelays, sleepImpl },
  )
  if (!response.ok) throw new Error(`GitHub Actions OIDC request was rejected (${response.status})`)
  const body = await response.json().catch(() => null)
  if (!body || typeof body.value !== "string" || !body.value)
    throw new Error("GitHub Actions OIDC endpoint returned an invalid response")
  return body.value
}

function checkedMcpUrl(value, server) {
  const serverUrl = secureUrl(server, "Derive server")
  const mcpUrl = secureUrl(value ?? `${server}/mcp`, "Derive MCP URL")
  if (mcpUrl.origin !== serverUrl.origin)
    throw new Error("Derive exchange returned an MCP URL on another origin")
  return mcpUrl.toString()
}

function checkedExchange(body, { server, now = Date.now() }) {
  if (!body || typeof body !== "object") throw new Error("Derive exchange returned invalid JSON")
  if (typeof body.token !== "string" || !body.token)
    throw new Error("Derive exchange did not return a workflow capability")
  if (typeof body.instruction !== "string" || !body.instruction.trim())
    throw new Error("Derive exchange did not return the pinned workflow instruction")
  const expiresAt = Date.parse(body.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 5_000)
    throw new Error("Derive exchange returned an expired workflow capability")
  return {
    token: body.token,
    instruction: body.instruction,
    expiresAt: body.expiresAt,
    mcpUrl: checkedMcpUrl(body.mcpUrl, server),
  }
}

export async function exchangeWorkflowCapability({
  server,
  runId,
  nonce,
  oidcToken,
  fetchImpl = fetch,
  retryDelays,
  sleepImpl,
  now,
}) {
  if (!validNonce(nonce)) throw new Error("workflow exchange nonce is missing or malformed")
  if (typeof oidcToken !== "string" || !oidcToken)
    throw new Error("GitHub Actions OIDC token is missing")
  const normalizedServer = normalizeWorkflowServer(server)
  // A retry replays this exact body. The server binds it to the assignment, nonce,
  // and GitHub run identity, so a lost response cannot create another authority.
  const body = JSON.stringify({ nonce, oidcToken })
  const response = await retryFetch(
    {
      label: "Derive workflow exchange",
      url: workflowExchangeUrl(normalizedServer, runId),
      init: {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body,
      },
    },
    { fetchImpl, retryDelays, sleepImpl },
  )
  if (!response.ok) throw new Error(`Derive workflow exchange was rejected (${response.status})`)
  const json = await response.json().catch(() => null)
  return checkedExchange(json, { server: normalizedServer, now })
}

const tomlString = (value) => JSON.stringify(String(value))

export function codexWorkflowArgs({ instruction, mcpUrl, model = null }) {
  const prompt = `You are the one authorized execution harness for this exact version-pinned Derive graph run.

Follow the pinned instruction below. Coordinate every Context node and every final step/run receipt through the Derive MCP \`use\` tool. Reuse the graph's existing approvals, loop bounds, sessions, and workflow state. Do not create another scheduler or receipt store. Continue until the graph reaches its honest terminal state or the existing protocol tells you it is waiting for a human. A dispatch or a clean process exit is not proof that the graph succeeded.

PINNED DERIVE WORKFLOW INSTRUCTION
${instruction}`
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--config",
    `mcp_servers.derive.url=${tomlString(mcpUrl)}`,
    "--config",
    `mcp_servers.derive.bearer_token_env_var=${tomlString(WORKFLOW_TOKEN_ENV)}`,
    "--config",
    'mcp_servers.derive.enabled_tools=["use"]',
    "--config",
    "mcp_servers.derive.required=true",
    ...(model ? ["--model", model] : []),
    prompt,
  ]
}

export function workflowAgentEnv(source, token) {
  const env = { ...source }
  // The exchange credentials have done their job. Codex gets only its owner-provided
  // model auth/config plus the short-lived Derive workflow capability it needs for MCP.
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL
  delete env.DERIVE_EXCHANGE_NONCE
  delete env.DERIVE_TOKEN
  delete env.DERIVE_WORKFLOW_RUN_ID
  env[WORKFLOW_TOKEN_ENV] = token
  return env
}

function timeoutFrom(value) {
  if (value == null || value === "") return DEFAULT_TIMEOUT_MS
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < 60_000 || timeout > MAX_TIMEOUT_MS)
    throw new Error("workflow timeout must be between 60000 and 21600000 milliseconds")
  return Math.floor(timeout)
}

function codexDiagnosticState() {
  return {
    tail: "",
    providerAuth: false,
    providerLimit: false,
    deriveMcp: false,
  }
}

function scanCodexDiagnostics(state, chunk) {
  // Keep only a small rolling window and emit only fixed classifications. Provider
  // diagnostics can repeat request configuration, so raw output must never reach logs.
  state.tail = `${state.tail}${chunk}`.slice(-CODEX_DIAGNOSTIC_WINDOW)
  const sample = state.tail.toLowerCase()
  if (
    (sample.includes("401 unauthorized") || sample.includes("invalid_api_key")) &&
    sample.includes("openai")
  )
    state.providerAuth = true
  if (
    sample.includes("insufficient_quota") ||
    sample.includes("rate_limit_exceeded") ||
    sample.includes("429 too many requests")
  )
    state.providerLimit = true
  if (
    sample.includes("required mcp servers failed to initialize") ||
    (sample.includes("derive") && sample.includes("mcp") && sample.includes("failed to initialize"))
  )
    state.deriveMcp = true
}

function logCodexFailureDiagnostic(state, log) {
  if (state.providerAuth) {
    log(
      "Codex provider authentication failed. Verify OPENAI_API_KEY or the configured workload identity in this GitHub environment.",
    )
    return
  }
  if (state.providerLimit) {
    log("The Codex provider blocked this run because of a rate or usage limit.")
    return
  }
  if (state.deriveMcp) log("Codex could not initialize the required Derive MCP connection.")
}

/** Spawn exactly one Codex process. Output is consumed as structured events, but only
 * event types are logged: model text and command output can contain repository secrets. */
export function spawnWorkflowAgent({
  bin = "codex",
  args,
  cwd = process.cwd(),
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  log = console.log,
}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      resolve({ code: -1, signal: null, timedOut: false })
      return
    }
    let finished = false
    let timedOut = false
    let killTimer = null
    let buffer = ""
    const diagnostics = codexDiagnosticState()
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve(result)
    }
    const take = (line) => {
      try {
        const event = JSON.parse(line)
        if (event.type === "item.completed" && SAFE_EVENT_TYPES.has(event.item?.type))
          log(`[codex] → ${event.item.type}`)
      } catch {
        // Codex occasionally writes diagnostics beside JSONL. Never echo them: this
        // process deliberately holds short-lived bearer and model credentials.
      }
    }
    child.stdout?.on("data", (chunk) => {
      scanCodexDiagnostics(diagnostics, chunk)
      buffer += chunk.toString()
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) take(line)
        newline = buffer.indexOf("\n")
      }
    })
    child.stderr?.on("data", (chunk) => scanCodexDiagnostics(diagnostics, chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, timeoutMs)
    child.once("error", () => finish({ code: -1, signal: null, timedOut: false }))
    child.once("close", (code, signal) => {
      if (buffer.trim()) take(buffer.trim())
      if (code !== 0) logCodexFailureDiagnostic(diagnostics, log)
      finish({ code, signal, timedOut })
    })
  })
}

export async function runGithubWorkflowHarness({
  runId,
  nonce,
  server = DEFAULT_SERVER,
  requestUrl,
  requestToken,
  cwd = process.cwd(),
  env = process.env,
  bin = env.CODEX_BIN ?? env.AGENT_BIN ?? "codex",
  model = env.DERIVE_CODEX_MODEL ?? null,
  timeoutMs = env.DERIVE_WORKFLOW_TIMEOUT_MS,
  fetchImpl = fetch,
  spawnImpl = spawn,
  retryDelays,
  sleepImpl,
  now,
  log = console.log,
}) {
  if (!validRunId(runId)) throw new Error("workflow run id is missing or malformed")
  if (!validNonce(nonce)) throw new Error("workflow exchange nonce is missing or malformed")
  const normalizedServer = normalizeWorkflowServer(server)
  const oidcToken = await requestGithubOidc({
    requestUrl,
    requestToken,
    fetchImpl,
    retryDelays,
    sleepImpl,
  })
  const exchange = await exchangeWorkflowCapability({
    server: normalizedServer,
    runId,
    nonce,
    oidcToken,
    fetchImpl,
    retryDelays,
    sleepImpl,
    now,
  })
  log("GitHub identity accepted; starting one authorized Codex harness.")
  const result = await spawnWorkflowAgent({
    bin,
    args: codexWorkflowArgs({
      instruction: exchange.instruction,
      mcpUrl: exchange.mcpUrl,
      model,
    }),
    cwd,
    env: workflowAgentEnv(env, exchange.token),
    timeoutMs: timeoutFrom(timeoutMs),
    spawnImpl,
    log,
  })
  if (result.timedOut) return 124
  if (!Number.isInteger(result.code) || result.code < 0) return 1
  return result.code
}
