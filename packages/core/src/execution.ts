/** The coding-agent runtimes an agent's jobs run with. */
export const EXECUTION_PROVIDERS = ["claude-code", "codex"] as const

export type ExecutionProvider = (typeof EXECUTION_PROVIDERS)[number]

/**
 * The immutable execution choice captured when a run enters the queue.
 *
 * It is captured with the work rather than read from the agent at execution time, so editing an
 * agent cannot silently move already-accepted work to another provider or location.
 * `model: null` deliberately means "the provider's verified default"; a future explicit model
 * picker can pin a concrete id without changing this contract.
 */
export interface RunExecution {
  version: 1
  provider: ExecutionProvider
  location: "hosted" | "local"
  model: string | null
}

export const DEFAULT_EXECUTION_PROVIDER: ExecutionProvider = "claude-code"

/** Read a run snapshot defensively, falling back only for historical rows. */
export const parseRunExecution = (
  meta: Record<string, unknown>,
  fallback: ExecutionProvider = DEFAULT_EXECUTION_PROVIDER,
): RunExecution => {
  const raw = meta.execution
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>
    const provider = EXECUTION_PROVIDERS.find((p) => p === value.provider)
    const location = value.location === "local" ? "local" : "hosted"
    const model = typeof value.model === "string" && value.model ? value.model : null
    if (provider) return { version: 1, provider, location, model }
  }
  return { version: 1, provider: fallback, location: "hosted", model: null }
}

/** Reasoning levels a harness may take. Which a model accepts is the harness's call. */
export const EXECUTION_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const
export type ExecutionEffort = (typeof EXECUTION_EFFORTS)[number]

/** Provider machine sizes, smallest first. */
export const SANDBOX_SIZES = ["small", "default", "large", "xlarge"] as const
export type SandboxSize = (typeof SANDBOX_SIZES)[number]

/**
 * The machine an agent's Derive jobs run on.
 *
 * `snapshot` names a prepared provider image (a Boat named snapshot). `fresh` builds a new
 * machine from it for every task instead of resuming the last one, so a task never inherits a
 * previous task's drift. `check` is a shell command the runner runs before the harness: a
 * nonzero exit ends the task with its output and spends no model tokens. `environment` attaches
 * the provider's named environment (its repositories, variables, and secret files); without it
 * the machine gets none of the account's secrets.
 */
export interface AgentSandbox {
  snapshot?: string
  environment?: string
  size?: SandboxSize
  fresh?: boolean
  check?: string
}

/** Read a stored machine spec defensively; unknown fields and bad values drop out. */
export const parseAgentSandbox = (json: string | null | undefined): AgentSandbox => {
  if (!json) return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const v = raw as Record<string, unknown>
  const size = SANDBOX_SIZES.find((s) => s === v.size)
  return {
    ...(typeof v.snapshot === "string" && v.snapshot ? { snapshot: v.snapshot } : {}),
    ...(typeof v.environment === "string" && v.environment ? { environment: v.environment } : {}),
    ...(size ? { size } : {}),
    ...(v.fresh === true ? { fresh: true } : {}),
    ...(typeof v.check === "string" && v.check.trim() ? { check: v.check } : {}),
  }
}

/**
 * How a Derive-machine task runs, chosen when it starts and kept for its life (job meta_json).
 *
 * `session` runs the agent's harness interactively for a person to attach to from their
 * terminal, instead of one headless turn per message. `repo` is `owner/name@ref` to check out
 * before the harness starts.
 */
export interface TaskOptions {
  session?: boolean
  repo?: string
}

/** `owner/name` or `owner/name@ref`, as GitHub names a repository and a branch, tag, or sha. */
export const TASK_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(@[A-Za-z0-9_./-]{1,200})?$/

/** Read a task's options from its job meta_json; anything else in it is ignored. */
export const taskOptions = (metaJson: string | null | undefined): TaskOptions => {
  if (!metaJson) return {}
  let raw: unknown
  try {
    raw = JSON.parse(metaJson)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const v = raw as Record<string, unknown>
  return {
    ...(v.session === true ? { session: true } : {}),
    ...(typeof v.repo === "string" && TASK_REPO.test(v.repo) ? { repo: v.repo } : {}),
  }
}
