/**
 * The client half of streamed replies: turning `session.delta` events into the text on screen.
 *
 * WHY THIS IS ITS OWN MODULE. Two surfaces render a streaming reply — the artifact chat rail
 * and the context console — and they used to each carry their own copy of these rules. The
 * copies disagreed, and one of them was wrong in a way no server test could see: it cleared the
 * streamed text whenever the transcript contained ANY agent message, which is permanently true
 * from the second question onward, so every poll wiped a reply mid-write. One tested module is
 * the fix for the class, not just that bug.
 *
 * The state is deliberately plain data with a pure transition function, because the interesting
 * rules (ordering, de-duplication, which attempt a slice belongs to) are exactly what a
 * node-environment unit test can pin — matching how the rest of apps/web tests hook logic.
 */

export interface DeltaState {
  /** The reply as far as it has arrived. Render this; it is never the record. */
  text: string
  /** Highest slice applied, for de-duplication. */
  seq: number
  /** Which model attempt `text` belongs to. */
  attempt: number
}

export const EMPTY_DELTA: DeltaState = { text: "", seq: 0, attempt: 0 }

/**
 * Fold one `session.delta` event into the current state. Returns the SAME object when the event
 * is not ours or not usable, so a caller can skip a re-render on identity.
 *
 * ORDERING. Slices are published in order but delivered over a Durable Object per publish, and
 * two concurrent fetches to one DO have no ordering guarantee — so a later slice can overtake an
 * earlier one. A slice that is not strictly newer is DROPPED rather than appended out of place:
 * a missing chunk reads as a gap that the settled transcript repairs a moment later, whereas
 * appending it in the wrong position puts visibly scrambled prose on screen. Deltas are a view,
 * so the cheap, self-healing failure is the right one. (Node's in-process bus publishes
 * synchronously and cannot reorder at all.)
 */
export const applyDelta = (
  state: DeltaState,
  raw: string,
  sessionId: string | null,
): DeltaState => {
  let p: { session_id?: string; seq?: number; text?: string; attempt?: number }
  try {
    p = JSON.parse(raw) as typeof p
  } catch {
    return state
  }
  // Belt and braces: the channel is per-user, but a session's events must never bleed into a
  // different session's transcript if two are open.
  if (!sessionId || p.session_id !== sessionId || typeof p.text !== "string") return state
  const seq = typeof p.seq === "number" ? p.seq : state.seq + 1
  if (seq <= state.seq) return state
  const attempt = typeof p.attempt === "number" ? p.attempt : state.attempt
  // A NEW ATTEMPT REPLACES. The agent loop re-generates a reply that missed its contract, and
  // the abandoned attempt never reaches the transcript — appending would show a garbled answer
  // that the settled message then contradicts.
  const fresh = attempt > state.attempt
  return { text: fresh ? p.text : state.text + p.text, seq, attempt }
}

/**
 * Should the provisional text be dropped, given the transcript that just arrived?
 *
 * Keyed on a NEW agent row appearing, never on one merely existing. "This transcript contains an
 * agent message" is true forever after the first answer, so using it would clear the stream on
 * every poll of every follow-up — the bug this module exists to prevent.
 */
export const supersededBy = (agentMessages: number, seenAgentMessages: number): boolean =>
  agentMessages > seenAgentMessages
