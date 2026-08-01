/**
 * IS THIS TURN GONE, or merely slow?
 *
 * An attended turn runs DETACHED (ctx.background → waitUntil on a Worker), so if the isolate dies
 * mid-turn there is nobody left to settle the session. It stays "working" for ever: no answer, no
 * error, no retry, and a surface showing a spinner until the person gives up. That happened on a
 * preview and the cause was never reproduced — which is precisely why this exists. A lane whose
 * failure mode is SILENCE cannot depend on having diagnosed every cause, because the one nobody
 * diagnosed is indistinguishable from a slow answer.
 *
 * A PREDICATE, separated from the reaping, because the judgement is the part worth testing and
 * the part that must never be wrong in the dangerous direction: killing a live turn loses an
 * answer somebody is waiting for and has already paid for.
 */

/** Past this, a turn is not slow, it is gone. Deliberately generous: the model call alone is
 *  capped at 120s and a turn may make several plus tool time, so this is not a latency budget. */
export const TURN_DEADLINE_MS = 10 * 60 * 1000

export const isAbandoned = (
  state: string,
  stamp: string | null | undefined,
  now: number,
  deadlineMs: number = TURN_DEADLINE_MS,
): boolean => {
  // "open" is NOT included: a context ask can legitimately sit open waiting on a human, and
  // reaping those would delete other people's pending work.
  if (state !== "working") return false
  if (!stamp) return false
  const at = new Date(stamp).getTime()
  // An unparseable stamp is not evidence of abandonment. Leaving a turn alone costs a spinner;
  // reaping one wrongly destroys an answer, so the unknown case defaults to leaving it.
  if (!Number.isFinite(at)) return false
  return now - at >= deadlineMs
}
