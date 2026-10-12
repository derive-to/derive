import type { JobResult } from "./agent-model"

// Standard text comparison rates. These never represent a plan invoice or a budget debit.
// Source: https://developers.openai.com/api/docs/pricing (checked 2026-10-12).
const VERSION = "openai-standard-text-2026-10-12"
const RATES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
}

/** Freeze the comparison at receipt time. Missing usage never becomes a zero estimate. */
export const priceJobRun = (run: NonNullable<JobResult["runs"]>[number]) => {
  const rate = run.provider === "codex" ? RATES[run.model] : undefined
  const input = run.input_tokens,
    cached = run.cached_input_tokens,
    output = run.output_tokens
  if (
    !rate ||
    input === null ||
    cached === null ||
    output === null ||
    input > 272_000 ||
    cached > input
  )
    return { ...run, api_estimate_micro_usd: null, price_version: null }
  return {
    ...run,
    api_estimate_micro_usd: Math.ceil(
      (input - cached) * rate.input + cached * rate.cached + output * rate.output,
    ),
    price_version: VERSION,
  }
}
