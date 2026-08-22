/** Stable capability levels authored into graphs. Providers and model versions are runtime data. */
export const AGENT_TIERS = ["utility", "fast", "balanced", "expert", "frontier"] as const

export type AgentTier = (typeof AGENT_TIERS)[number]

/**
 * Versionless model-family handles understood by Derive's execution harnesses.
 *
 * The list includes Derive's native families plus every family represented in OpenRouter's
 * trailing-30-day top ten on 2026-08-21. Two ranked DeepSeek Flash versions intentionally fold
 * into one family: saved graphs should survive a provider's next model refresh.
 *
 * Source: OpenRouter (openrouter.ai/rankings), as of 2026-08-21.
 */
export const MODEL_FAMILY_TIERS = {
  utility: "utility",
  "deepseek-v4-flash": "fast",
  mimo: "fast",
  "nemotron-ultra": "fast",
  luna: "balanced",
  hy3: "balanced",
  glm: "balanced",
  terra: "expert",
  sonnet: "expert",
  "deepseek-v4-pro": "expert",
  ox: "expert",
  sol: "frontier",
  fable: "frontier",
  opus: "frontier",
} as const satisfies Record<string, AgentTier>

export type ModelFamily = keyof typeof MODEL_FAMILY_TIERS

export const isAgentTier = (value: unknown): value is AgentTier =>
  typeof value === "string" && AGENT_TIERS.includes(value as AgentTier)

export const tierForModelFamily = (family: string): AgentTier | null =>
  Object.hasOwn(MODEL_FAMILY_TIERS, family) ? MODEL_FAMILY_TIERS[family as ModelFamily] : null
