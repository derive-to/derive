/** Insights derivations kept out of the dialog so they can be tested directly. */

const DAY_MS = 86400_000

/** `daily` from the analytics endpoint carries ONLY the days that have views —
 *  `GROUP BY day` cannot emit a row for a day nobody opened. Rendering it straight
 *  draws three scattered days as three adjacent bars, so the trend reads as a run of
 *  consecutive activity. Put the empty days back: `days` buckets ending on `endDay`
 *  (a YYYY-MM-DD key), oldest first, zeros where nothing was recorded. */
export function trendSeries(
  daily: { day: string; count: number }[],
  endDay: string,
  days = 30,
): { day: string; count: number }[] {
  const counts = new Map(daily.map((d) => [d.day, d.count]))
  const end = Date.parse(`${endDay}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10)
    return { day, count: counts.get(day) ?? 0 }
  })
}
