import { describe, expect, it } from "vitest"
import { runOutcome, runStatusLabel, triggerLabel } from "./automation-format"

describe("triggerLabel", () => {
  it("labels each trigger kind in plain words", () => {
    expect(triggerLabel({ kind: "manual" })).toBe("Run on demand")
    expect(triggerLabel({ kind: "schedule", cron: "0 9 * * 1-5", tz: "UTC" })).toBe(
      "Weekdays at 9:00 AM",
    )
    expect(triggerLabel({ kind: "event", on: "upstream.published" })).toBe(
      "When a doc it depends on updates",
    )
  })
  it("falls back gracefully for a custom cron or unknown event", () => {
    expect(triggerLabel({ kind: "schedule", cron: "*/5 * * * *" })).toBe("Schedule · */5 * * * *")
    expect(triggerLabel({ kind: "event", on: "custom.thing" })).toBe("On custom.thing")
  })
})

describe("run helpers", () => {
  it("maps status to a one-word label", () => {
    expect(runStatusLabel("queued")).toBe("Queued")
    expect(runStatusLabel("succeeded")).toBe("Done")
    expect(runStatusLabel("failed")).toBe("Failed")
  })
  it("reads the outcome from the meta blob, tolerating junk", () => {
    expect(runOutcome(JSON.stringify({ outcome: "published" }))).toBe("published")
    expect(runOutcome(null)).toBeNull()
    expect(runOutcome("not json")).toBeNull()
    expect(runOutcome(JSON.stringify({ other: 1 }))).toBeNull()
  })
})
