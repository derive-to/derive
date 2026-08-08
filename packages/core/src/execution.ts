/** The coding-agent runtimes Derive can execute for unattended work. */
export const EXECUTION_PROVIDERS = ["claude-code", "codex"] as const

export type ExecutionProvider = (typeof EXECUTION_PROVIDERS)[number]

/**
 * The immutable execution choice captured when a run enters the queue.
 *
 * It lives in run.meta rather than being read from the automation at execution time, so editing
 * a routine cannot silently move already-accepted work to another provider or location.
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
