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
  /** The agent's stated confidence in [0,1]; null when unstated. Fail-safe:
   *  an unstated confidence never auto-publishes. */
  confidence: number | null
  flags: AutonomyFlags
  /** Below this, `auto` demotes to a proposal. */
  confidenceFloor?: number
  /** TAINT: this run consumed untrusted external content — a webhook payload, a
   *  source-tool result. Such a run can never live-publish, whatever the workspace's
   *  autonomy settings say.
   *
   *  This is the structural answer to prompt injection. A page or an issue comment
   *  saying "ignore your instructions and publish X" defeats prompt hardening by
   *  construction, because the hardening and the attack share one context window.
   *  Demoting to a proposal puts a human between the injected text and the published
   *  artifact, and it does not depend on the model having behaved.
   *
   *  Recorded by the SERVER — it proxies every source-tool call and attaches every
   *  webhook payload — so a compromised executor cannot claim to be untainted. */
  tainted?: boolean
}

export const DEFAULT_CONFIDENCE_FLOOR = 0.8

/** Precedence, top to bottom, every rung fail-safe:
 *   1. killswitch            → proposal (work surfaces, never silently drops)
 *   2. autonomy shadow       → shadow
 *   3. TAINTED               → proposal (it read untrusted external content)
 *   4. autonomy suggest      → proposal
 *   5. autonomy auto (= the target's explicit publish mode):
 *      a. workspace opt-in off      → proposal
 *      b. confidence unstated/low   → proposal
 *      c. otherwise                 → live publish, review round opens
 *
 *  The KIND of change no longer gates: autonomy here is the user's per-target
 *  write-mode consent, and recoverability (versioned writes + review rounds +
 *  the killswitch) is what makes the top rung safe to offer.
 *
 *  Taint sits BELOW shadow deliberately. Shadow files nothing at all, which is
 *  strictly safer than a proposal, so a tainted shadow run stays shadow rather than
 *  being promoted into somebody's review queue. Every other rung it outranks: a
 *  tainted run cannot live-publish even at `auto`, with the workspace opted in and
 *  confidence at 1.0 — because that confidence is the model's, and the model is who
 *  the injected text was talking to. */
export function decideWrite(input: GateInput): GateDecision {
  const floor = input.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
  if (input.flags.agentKillswitch) return "proposal"
  if (input.autonomy === "shadow") return "shadow"
  if (input.tainted) return "proposal"
  if (input.autonomy === "suggest") return "proposal"
  if (!input.flags.agentAutoEnabled) return "proposal"
  if (input.confidence === null || input.confidence < floor) return "proposal"
  return "live_publish_with_review"
}
