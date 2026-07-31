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

/** Gate inputs the caller reads fresh per run — never cached across runs. Two are
 *  workspace switches; `credentialed` is a property of THIS run. */
export interface AutonomyFlags {
  /** Demotes EVERY write to a proposal, instantly. A killswitch surfaces work
   *  for humans rather than hiding it, so it never demotes to shadow. */
  agentKillswitch: boolean
  /** Workspace opt-in for `auto` to live-publish. Off = auto behaves as suggest. */
  agentAutoEnabled: boolean
  /** This run can spend a credential — it resolved at least one bound connection.
   *  Required rather than optional so the compiler names every construction site: a
   *  forgotten field would default to "not credentialed", which fails OPEN. */
  credentialed: boolean
}

export interface GateInput {
  autonomy: AutonomyLevel
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
 *   3. credentialed run      → proposal
 *   4. autonomy suggest      → proposal
 *   5. autonomy auto (= the target's explicit publish mode):
 *      a. workspace opt-in off      → proposal
 *      b. confidence unstated/low   → proposal
 *      c. otherwise                 → live publish, review round opens
 *
 *  Rung 3 is the connections plan's "taint": a run that can spend a credential reads
 *  outside data and acts with real access, so it files for a human instead of
 *  publishing. It sits BELOW shadow deliberately — filing nothing is safer than
 *  filing a proposal, so a shadow rollout doesn't get louder because the run held a
 *  key — and ABOVE the consent rungs, so no per-target mode or confidence score can
 *  buy its way past it.
 *
 *  SCOPE, stated honestly, because the plan has been describing this as a guarantee
 *  and it is not one. This function is advisory: it runs INSIDE the executor, and a
 *  run's model already holds the agent token in its environment (the tool shim needs
 *  it), so a prompt-injected model that decides to POST the publish route directly
 *  never passes through here. The server does not re-check at write time. That is
 *  equally true of the killswitch above — every rung here is defense against an
 *  executor doing its job, not against one that has been turned. What this rung
 *  genuinely buys: the ordinary path of a credentialed run cannot land live content
 *  without a human, so the failure needs an ACTIVE hijack rather than a plausible
 *  wrong answer. Making it a real guarantee means enforcing it server-side at the
 *  publish route (the run id is already on the claim); until then, do not describe
 *  it as one.
 *
 *  The KIND of change no longer gates: autonomy here is the user's per-target
 *  write-mode consent, and recoverability (versioned writes + review rounds +
 *  the killswitch) is what makes the top rung safe to offer. */
export function decideWrite(input: GateInput): GateDecision {
  const floor = input.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
  if (input.flags.agentKillswitch) return "proposal"
  if (input.autonomy === "shadow") return "shadow"
  if (input.flags.credentialed) return "proposal"
  if (input.autonomy === "suggest") return "proposal"
  if (!input.flags.agentAutoEnabled) return "proposal"
  if (input.confidence === null || input.confidence < floor) return "proposal"
  return "live_publish_with_review"
}
