/**
 * RUN POLICY — the decisions both executors make, written once.
 *
 * The run CONTRACT (what output to ask for, how to read it) already lives in run-contract.ts.
 * This is the other half: what to do when the reply is wrong, what is worth paying to retry, and
 * how spend adds up. The container executor and the in-Worker agent loop were each deciding these
 * separately, which is how two substrates quietly stop being comparable — the same automation
 * would retry a different number of times, or report a different cost, depending on where it ran.
 *
 * The CLI cannot import this at runtime (dependency-free published package), so it hand-copies
 * the constants and packages/cli/test/gate-parity.test.js holds it to them — the same arrangement
 * as decideWrite, the run contract, and the agent surface.
 */

/**
 * How many times to re-ask for the required output block after a reply that lacked it.
 *
 * ONE. Models routinely describe a change instead of emitting it, and a single reminder recovers
 * work that is already paid for. A second reminder pays again for the same failure: a model that
 * ignored the contract twice will ignore it a third time.
 */
export const NUDGE_LIMIT = 1

/**
 * Accumulate reported spend, in USD, across the attempts of one run.
 *
 * Null means UNKNOWN, never zero — a provider that reports nothing (Codex plain-text mode, an
 * older CLI) must not make a run look free, because the workspace budget sums these. So null plus
 * a number is that number, null plus null stays null, and a non-finite value is ignored rather
 * than poisoning the total with NaN.
 *
 * Accumulating (not replacing) is the point: a run that burned three attempts and produced
 * nothing still cost money, and reporting only the last attempt undercounts exactly the runs that
 * went worst. The same rule holds in the database, where a retry reuses the run row.
 */
export const addCostUsd = (acc: number | null, next: number | null | undefined): number | null =>
  typeof next === "number" && Number.isFinite(next) ? (acc ?? 0) + next : acc

/**
 * Is a failed attempt worth paying to repeat?
 *
 * Only when the SERVICE failed, never when the request did. A 429 or 5xx often succeeds on a
 * second attempt; a reply that parsed cleanly but ignored the output contract will fail
 * identically, and retrying it spends the owner's plan twice for the same answer.
 *
 * The executor decides this; the server owns the policy that acts on it (how many retries, what
 * backoff). Keeping the judgement here means both executors make it the same way.
 */
export const isRetryableFailure = (input: {
  /** The model call itself failed to complete (network, 429, 5xx). */
  transportFailed?: boolean
  /** HTTP-ish status the provider reported, when it reported one. */
  status?: number | null
  /** The attempt ran to completion but produced no usable output. */
  unparseable?: boolean
}): boolean => {
  if (input.transportFailed) return true
  if (typeof input.status === "number") return input.status === 429 || input.status >= 500
  // A clean run that simply did not follow the contract is deterministic.
  return input.unparseable ? false : false
}
