/**
 * Discriminators that GROW, validated server-side instead of by enum.
 *
 * MCP clients cache the tool schema at connect. That makes a `z.enum` a promise you
 * can't revise: add a value, and every already-connected client rejects it LOCALLY —
 * the request never reaches the server, so no amount of server-side tolerance helps.
 * We shipped that exact failure twice (`automate action:'create_context'`, then
 * `stage target:'api'`): the capability was live, correct, and unreachable until a
 * human reconnected the connector.
 *
 * So for the handful of parameters that SELECT A CAPABILITY — the ones a new feature
 * naturally extends — the schema says `string` and this module does the checking. A
 * stale client passes the new value straight through; a genuinely wrong value gets a
 * better error than a client-side type failure ever was, because it can name the
 * alternatives and steer.
 *
 * This is deliberately NOT the default. Closed vocabularies (an access level, a
 * reaction, a terminal state) should stay enums: they don't grow, and there the
 * client refusing early is exactly right — invalid states unrepresentable. Loosen a
 * parameter only once it has actually grown, or is obviously going to.
 */

/** Describe an open choice for a tool's `inputSchema` — the valid values belong in
 *  the description, since the type no longer carries them (the model reads both). */
export const choiceDescription = (values: readonly string[], lead: string): string =>
  `${lead} One of: ${values.join(", ")}.`

/**
 * Validate an open choice. Returns null when `value` is allowed, or an actionable
 * error message naming what IS allowed. A near-miss (case or whitespace only) is
 * called out as such, because that is the likeliest way a hand-written call fails.
 */
export const badChoice = (
  param: string,
  value: string,
  values: readonly string[],
): string | null => {
  if (values.includes(value)) return null
  const normalized = value.trim().toLowerCase()
  const near = values.find((v) => v.toLowerCase() === normalized)
  if (near) return `\`${param}\` must be exactly "${near}" (got "${value}").`
  return `Unknown \`${param}\` "${value}". Valid: ${values.join(", ")}.`
}
