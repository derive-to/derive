import { Cron } from "croner"

/** The most recent cron occurrence at or before `now`, or null on a malformed expression (a bad
 *  cron must never 500 a claim — it just never fires). croner's previousRuns is relative to the
 *  passed date, so this is the fire time of the window `now` currently sits in. */
export const previousOccurrence = (
  cron: string,
  tz: string | undefined,
  now: Date,
): Date | null => {
  try {
    // +1s so a fire landing exactly on `now` counts as this window, not the previous one.
    const ref = new Date(now.getTime() + 1000)
    const [prev] = new Cron(cron, tz ? { timezone: tz } : {}).previousRuns(1, ref)
    return prev ?? null
  } catch {
    return null
  }
}
