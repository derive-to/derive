// The autonomy gate: ONE pure function deciding how a hosted agent's write
// lands — a live publish (which always opens a review round), a proposal a
// human approves, or a shadow record that files nothing. Adapted from Sift's
// decideSend pattern: the caller loads workspace flags fresh per run and this
// function does no I/O, so the whole policy is a unit-testable truth table and
// flipping the killswitch takes effect on the very next run. Consumed at the
// single write chokepoint in the agent host; no other code path may decide.

/** Per-artifact (or per-context) autonomy level. `shadow` is the rollout tier:
 *  the run happens and is recorded, nothing is filed. */
export type AutonomyLevel = "shadow" | "suggest" | "auto"

/** What kind of change the write is: a freshness refresh (dates, statuses,
 *  counts — the things a living declaration names), a structural edit, or the
 *  creation of a NEW artifact. Freshness/structural come from the diff
 *  classifier (when in doubt, structural); creation is declared by the write
 *  path itself (no before-text exists). Creation is additive — it cannot damage
 *  an existing trusted doc — so it rides the freshness rung at `auto`, not the
 *  structural one. */
export type ChangeKind = "freshness" | "structural" | "creation"

export type GateDecision = "live_publish_with_review" | "proposal" | "shadow"

/** Workspace flags, read fresh by the caller per run — never cached across runs. */
export interface AutonomyFlags {
  /** Demotes EVERY write to a proposal, instantly. A killswitch surfaces work
   *  for humans rather than hiding it, so it never demotes to shadow. */
  agentKillswitch: boolean
  /** Workspace opt-in for `auto` to live-publish. Off = auto behaves as suggest. */
  agentAutoEnabled: boolean
}

export interface GateInput {
  autonomy: AutonomyLevel
  changeKind: ChangeKind
  /** The agent's stated confidence in [0,1]; null when unstated. Fail-safe:
   *  an unstated confidence never auto-publishes. */
  confidence: number | null
  flags: AutonomyFlags
  /** Below this, `auto` demotes to a proposal. */
  confidenceFloor?: number
}

export const DEFAULT_CONFIDENCE_FLOOR = 0.8

/** Precedence, top to bottom, every rung fail-safe:
 *   1. killswitch            → proposal (work surfaces, never silently drops)
 *   2. autonomy shadow       → shadow
 *   3. autonomy suggest      → proposal
 *   4. autonomy auto:
 *      a. workspace opt-in off      → proposal
 *      b. structural change         → proposal (freshness and additive
 *                                     creations may auto-publish; edits that
 *                                     reshape an existing doc may not)
 *      c. confidence unstated/low   → proposal
 *      d. otherwise                 → live publish, review round opens
 */
export function decideWrite(input: GateInput): GateDecision {
  const floor = input.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
  if (input.flags.agentKillswitch) return "proposal"
  if (input.autonomy === "shadow") return "shadow"
  if (input.autonomy === "suggest") return "proposal"
  if (!input.flags.agentAutoEnabled) return "proposal"
  if (input.changeKind === "structural") return "proposal"
  if (input.confidence === null || input.confidence < floor) return "proposal"
  return "live_publish_with_review"
}
