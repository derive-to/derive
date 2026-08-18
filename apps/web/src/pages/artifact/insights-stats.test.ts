import { describe, expect, it } from "vitest"
import { trendSeries } from "./insights-stats"

// The Insights sparkline's x-axis. The API returns only days that HAVE views
// (GROUP BY drops the empty ones), so the chart has to put the gaps back.
describe("trendSeries", () => {
  it("returns one bucket per day of the window, oldest first", () => {
    const s = trendSeries([], "2026-08-18", 30)
    expect(s).toHaveLength(30)
    expect(s[0]?.day).toBe("2026-07-20")
    expect(s.at(-1)?.day).toBe("2026-08-18")
    expect(s.every((d) => d.count === 0)).toBe(true)
  })

  it("fills the days between recorded ones with zeros", () => {
    const s = trendSeries(
      [
        { day: "2026-08-15", count: 16 },
        { day: "2026-08-17", count: 1 },
      ],
      "2026-08-18",
      5,
    )
    expect(s).toEqual([
      { day: "2026-08-14", count: 0 },
      { day: "2026-08-15", count: 16 },
      { day: "2026-08-16", count: 0 },
      { day: "2026-08-17", count: 1 },
      { day: "2026-08-18", count: 0 },
    ])
  })

  it("drops days that fall outside the window", () => {
    const s = trendSeries(
      [
        { day: "2026-07-01", count: 99 },
        { day: "2026-08-18", count: 2 },
      ],
      "2026-08-18",
      3,
    )
    expect(s.map((d) => d.count)).toEqual([0, 0, 2])
  })

  it("crosses a month boundary without inventing days", () => {
    expect(trendSeries([], "2026-03-02", 4).map((d) => d.day)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ])
  })
})
