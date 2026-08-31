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
const DEFAULT_CLOUD_AGENT_URL = ""
const DEFAULT_CLOUD_POLL_MS = 5_000
const CLOUD_RUN_STATUSES = new Set(["pending", "queued", "running"])
const CLOUD_TERMINAL_STATUSES = new Set(["finished", "error", "cancelled"])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const validRunId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)

const validNonce = (value) =>
  typeof value === "string" && value.length >= 16 && value.length <= 512 && !/\s/.test(value)

const validEnvironmentName = (value) =>
  typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value)

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

export function workflowStatusUrl(server, runId) {
  if (!validRunId(runId)) throw new Error("workflow run id is missing or malformed")
  return `${normalizeWorkflowServer(server)}/v1/workflow-runs/${encodeURIComponent(runId)}/github/status`
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

function codexProviderArgs(provider) {
  if (!provider) return []
  const url = secureUrl(provider.baseUrl, "Codex provider")
  if (url.search || url.hash)
    throw new Error("Codex provider URL must not contain a query or fragment")
  if (!validEnvironmentName(provider.apiKeyEnv))
    throw new Error("Codex provider API key environment name is malformed")
  const id = "derive-workflow-provider"
  return [
    "--config",
    `model_provider=${tomlString(id)}`,
    "--config",
    `model_providers.${id}.name=${tomlString("Workflow provider")}`,
    "--config",
    `model_providers.${id}.base_url=${tomlString(url.toString().replace(/\/+$/, ""))}`,
    "--config",
    `model_providers.${id}.env_key=${tomlString(provider.apiKeyEnv)}`,
    "--config",
    `model_providers.${id}.wire_api=${tomlString("responses")}`,
    "--config",
    `model_providers.${id}.requires_openai_auth=false`,
  ]
}

export function workflowHarnessPrompt(instruction) {
  return `You are the one authorized execution harness for this exact version-pinned Derive graph run.

Follow the pinned instruction below. Coordinate every Context node and every final step/run receipt through the Derive MCP \`use\` tool. Reuse the graph's existing approvals, loop bounds, sessions, and workflow state. Do not create another scheduler or receipt store. Continue until the graph reaches its honest terminal state or the existing protocol tells you it is waiting for a human. A dispatch or a clean process exit is not proof that the graph succeeded.

PINNED DERIVE WORKFLOW INSTRUCTION
${instruction}`
}

export function codexWorkflowArgs({ instruction, mcpUrl, model = null, provider = null }) {
  const prompt = workflowHarnessPrompt(instruction)
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
    ...codexProviderArgs(provider),
    ...(model ? ["--model", model] : []),
    prompt,
  ]
}

function normalizeCloudAgentUrl(value) {
  const url = secureUrl(value, "Cloud agent API")
  if (url.search || url.hash)
    throw new Error("Cloud agent API must not contain a query or fragment")
  return url.toString().replace(/\/+$/, "")
}

function cloudAgentHeaders(clientId, clientSecret) {
  if (typeof clientId !== "string" || !clientId.trim())
    throw new Error("cloud agent access client id is missing")
  if (typeof clientSecret !== "string" || !clientSecret.trim())
    throw new Error("cloud agent access client secret is missing")
  return {
    accept: "application/json",
    "content-type": "application/json",
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  }
}

async function cloudAgentRequest({ url, init, label, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(url, init)
  } catch {
    throw new Error(`${label} could not be reached`)
  }
  if (!response.ok) throw new Error(`${label} was rejected (${response.status})`)
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== "object") throw new Error(`${label} returned invalid JSON`)
  return body
}

async function readWorkflowStatus({ server, runId, token, fetchImpl }) {
  const body = await cloudAgentRequest({
    url: workflowStatusUrl(server, runId),
    init: {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    },
    label: "Derive workflow receipt check",
    fetchImpl,
  })
  if (typeof body.status !== "string" || typeof body.terminal !== "boolean")
    throw new Error("Derive workflow receipt check returned an invalid response")
  return body
}

/** Run one pinned graph through a Cursor-shaped cloud-agent control plane. The
 * Derive capability travels in a dedicated secret field, never prompt text or logs. */
export async function runCloudWorkflowAgent({
  server,
  runId,
  exchange,
  apiUrl,
  clientId,
  clientSecret,
  model = "gpt-5.6-terra",
  environment = "base",
  boxType = "large",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_CLOUD_POLL_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = () => Date.now(),
  log = console.log,
}) {
  const baseUrl = normalizeCloudAgentUrl(apiUrl)
  const headers = cloudAgentHeaders(clientId, clientSecret)
  if (!Number.isFinite(pollMs) || pollMs < 250 || pollMs > 60_000)
    throw new Error("cloud agent poll interval must be between 250 and 60000 milliseconds")
  const name = `derive-${runId}`
  let created
  try {
    created = await cloudAgentRequest({
      url: `${baseUrl}/v1/agents`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          harness: "codex",
          model,
          name,
          description: `Version-pinned Derive graph run ${runId}`,
          prompt: { text: workflowHarnessPrompt(exchange.instruction) },
          environment,
          boxType,
          deriveWorkflow: { token: exchange.token, mcpUrl: exchange.mcpUrl },
        }),
      },
      label: "Cloud agent creation",
      fetchImpl,
    })
  } catch (creationError) {
    // A lost 201 response must not create a second sandbox. The run id makes
    // this name unique, so recover the accepted assignment from the index.
    const listed = await cloudAgentRequest({
      url: `${baseUrl}/v1/agents`,
      init: { method: "GET", headers },
      label: "Cloud agent assignment recovery",
      fetchImpl,
    }).catch(() => null)
    const recovered = listed?.agents
      ?.filter(
        (agent) =>
          agent?.name === name &&
          agent?.harness === "codex" &&
          agent?.status !== "error" &&
          typeof agent?.latestRunId === "string" &&
          agent.latestRunId,
      )
      .at(-1)
    if (!recovered) throw creationError
    created = { agent: recovered, run: { id: recovered.latestRunId } }
  }
  const agentId = created.agent?.id
  const cloudRunId = created.run?.id
  if (typeof agentId !== "string" || !agentId || typeof cloudRunId !== "string" || !cloudRunId)
    throw new Error("Cloud agent creation returned an invalid assignment")
  log(`Cloud agent ${agentId} accepted Derive run ${runId}.`)

  const deadline = now() + timeoutMs
  let lastStatus = ""
  let terminalStatus = ""
  let consecutiveCheckFailures = 0
  try {
    while (now() < deadline) {
      let body
      try {
        body = await cloudAgentRequest({
          url: `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(cloudRunId)}`,
          init: { method: "GET", headers },
          label: "Cloud agent run check",
          fetchImpl,
        })
        consecutiveCheckFailures = 0
      } catch (error) {
        consecutiveCheckFailures += 1
        if (consecutiveCheckFailures >= 3) throw error
        log("Cloud agent status is temporarily unavailable; retrying.")
        await sleepImpl(Math.max(250, pollMs))
        continue
      }
      const status = body.run?.status
      if (
        typeof status !== "string" ||
        (!CLOUD_RUN_STATUSES.has(status) && !CLOUD_TERMINAL_STATUSES.has(status))
      )
        throw new Error("Cloud agent run check returned an invalid status")
      if (status !== lastStatus) {
        log(`Cloud agent run is ${status}.`)
        lastStatus = status
      }
      if (CLOUD_TERMINAL_STATUSES.has(status)) {
        terminalStatus = status
        break
      }
      await sleepImpl(Math.max(250, pollMs))
    }
    if (!terminalStatus) {
      await cloudAgentRequest({
        url: `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(cloudRunId)}/cancel`,
        init: { method: "POST", headers },
        label: "Cloud agent cancellation",
        fetchImpl,
      }).catch(() => null)
      return 124
    }
    if (terminalStatus !== "finished") return 1

    // The process result is necessary but not sufficient. Read the Derive
    // ledger with the same one-run capability and require its terminal receipt.
    let receipt = null
    let receiptError = null
    for (const delay of [0, 250, 1_000]) {
      if (delay) await sleepImpl(delay)
      try {
        receipt = await readWorkflowStatus({
          server,
          runId,
          token: exchange.token,
          fetchImpl,
        })
        receiptError = null
      } catch (error) {
        receiptError = error
        continue
      }
      if (receipt.terminal) break
    }
    if (receiptError && !receipt) throw receiptError
    if (receipt?.status === "succeeded") {
      log("Derive recorded a terminal successful graph receipt.")
      return 0
    }
    log("Cloud agent exited without a terminal successful Derive graph receipt.")
    return 1
  } finally {
    await cloudAgentRequest({
      url: `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/archive`,
      init: { method: "POST", headers },
      label: "Cloud agent archive",
      fetchImpl,
    }).catch(() => null)
  }
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
    providerCompatibility: false,
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
    (sample.includes("404 not found") || sample.includes("status 404")) &&
    sample.includes("/responses")
  )
    state.providerCompatibility = true
  if (
    sample.includes("required mcp servers failed to initialize") ||
    (sample.includes("derive") && sample.includes("mcp") && sample.includes("failed to initialize"))
  )
    state.deriveMcp = true
}

function logCodexFailureDiagnostic(state, log) {
  if (state.providerAuth) {
    log(
      "Codex provider authentication failed. Verify the model API key or configured workload identity in this GitHub environment.",
    )
    return
  }
  if (state.providerLimit) {
    log("The Codex provider blocked this run because of a rate or usage limit.")
    return
  }
  if (state.providerCompatibility) {
    log("The Codex provider does not expose the required Responses API for this model.")
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
  providerBaseUrl = env.DERIVE_CODEX_PROVIDER_BASE_URL ?? null,
  providerApiKeyEnv = env.DERIVE_CODEX_PROVIDER_API_KEY_ENV ?? "OPENAI_API_KEY",
  cloudAgentUrl = env.DERIVE_CLOUD_AGENT_URL ?? DEFAULT_CLOUD_AGENT_URL,
  cloudAgentClientId = env.DERIVE_CLOUD_AGENT_ACCESS_CLIENT_ID ?? "",
  cloudAgentClientSecret = env.DERIVE_CLOUD_AGENT_ACCESS_CLIENT_SECRET ?? "",
  cloudAgentModel = env.DERIVE_CLOUD_AGENT_MODEL ?? "gpt-5.6-terra",
  cloudAgentEnvironment = env.DERIVE_CLOUD_AGENT_ENVIRONMENT ?? "base",
  cloudAgentBoxType = env.DERIVE_CLOUD_AGENT_BOX_TYPE ?? "large",
  cloudAgentPollMs = Number(env.DERIVE_CLOUD_AGENT_POLL_MS ?? DEFAULT_CLOUD_POLL_MS),
  timeoutMs = env.DERIVE_WORKFLOW_TIMEOUT_MS,
  fetchImpl = fetch,
  spawnImpl = spawn,
  retryDelays,
  sleepImpl,
  now,
  clock = () => Date.now(),
  log = console.log,
}) {
  if (!validRunId(runId)) throw new Error("workflow run id is missing or malformed")
  if (!validNonce(nonce)) throw new Error("workflow exchange nonce is missing or malformed")
  if (providerBaseUrl && !model)
    throw new Error("DERIVE_CODEX_MODEL is required with a custom Codex provider")
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
  if (cloudAgentUrl) {
    log("GitHub identity accepted; starting one authorized cloud agent.")
    return runCloudWorkflowAgent({
      server: normalizedServer,
      runId,
      exchange,
      apiUrl: cloudAgentUrl,
      clientId: cloudAgentClientId,
      clientSecret: cloudAgentClientSecret,
      model: cloudAgentModel,
      environment: cloudAgentEnvironment,
      boxType: cloudAgentBoxType,
      timeoutMs: timeoutFrom(timeoutMs),
      pollMs: cloudAgentPollMs,
      fetchImpl,
      sleepImpl,
      now: clock,
      log,
    })
  }
  log("GitHub identity accepted; starting one authorized Codex harness.")
  const result = await spawnWorkflowAgent({
    bin,
    args: codexWorkflowArgs({
      instruction: exchange.instruction,
      mcpUrl: exchange.mcpUrl,
      model,
      provider: providerBaseUrl ? { baseUrl: providerBaseUrl, apiKeyEnv: providerApiKeyEnv } : null,
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
