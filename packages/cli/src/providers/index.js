// The agent-provider registry. Each provider drives one agent CLI; the runner
// core is agnostic and talks only to this shape, so adding a provider is one new
// file plus one line here. Auth is always the provider CLI's own concern (a plan
// OAuth token or an API key from the inherited env), never reimplemented.
//
// AgentProvider shape:
//   name         string            — id used by --provider / RUNNER_PROVIDER
//   defaultModel string            — used when neither --model nor RUNNER_MODEL is set
//   defaultBin   string            — the binary name if none is configured
//   binFrom(flags, env) -> string  — resolve the binary from flags/env
//   run(opts)    -> Promise<RunResult>
//     opts:      { bin, cwd, model, systemPrompt, prompt, timeoutMs, resumeSessionId }
//                systemPrompt already includes the runner's <answer> contract.
//     RunResult: { timedOut, code, resultText, sessionId, stderr, lastText, isError, apiErrorStatus }
//                resultText is the reply the runner parses for the <answer> block;
//                sessionId (or null) is what a resume/nudge continues.
//   retryable(RunResult) -> boolean — service failure (retry) vs config failure (don't)
//   version(bin) -> Promise<string|null> — for `runner doctor`
import { claudeCode } from "./claude-code.js"
import { codex } from "./codex.js"

/** name → provider. claude-code is the default and the verified reference impl;
 *  codex is experimental (see its header). */
export const PROVIDERS = {
  [claudeCode.name]: claudeCode,
  [codex.name]: codex,
}

export const DEFAULT_PROVIDER = claudeCode.name

/** Resolve a provider by name, failing loudly on an unknown one (a typo in
 *  --provider should not silently fall back to a different agent). */
export function selectProvider(name) {
  const key = name || DEFAULT_PROVIDER
  const provider = PROVIDERS[key]
  if (!provider)
    throw new Error(`unknown provider "${key}" — known: ${Object.keys(PROVIDERS).join(", ")}`)
  return provider
}
