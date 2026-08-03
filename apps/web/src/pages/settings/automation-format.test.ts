import { describe, expect, it } from "vitest"
import type { AutomationRef } from "@/api"
import {
  runOutcome,
  runStatusLabel,
  runWrites,
  stampMode,
  targetSummary,
  triggerLabel,
} from "./automation-format"

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

describe("stampMode", () => {
  const targets: AutomationRef[] = [
    { kind: "artifact", id: "a1" },
    { kind: "collection", id: "c1" },
    { kind: "tag", tag: "weekly" },
  ]
  it("publish stamps mode on every target; the artifact/collection/tag kinds are preserved", () => {
    expect(stampMode(targets, "publish")).toEqual([
      { kind: "artifact", id: "a1", mode: "publish" },
      { kind: "collection", id: "c1", mode: "publish" },
      { kind: "tag", tag: "weekly", mode: "publish" },
    ])
  })
  it("propose is the default — targets stay bare (the canonical minimal form)", () => {
    expect(stampMode(targets, "propose")).toEqual(targets)
    expect(stampMode(targets, "propose").every((r) => !("mode" in r))).toBe(true)
  })
  it("empty targets → empty", () => {
    expect(stampMode([], "publish")).toEqual([])
  })
})

describe("targetSummary", () => {
  it("counts by kind and pluralizes; empty when there are no targets", () => {
    expect(targetSummary([])).toBe("")
    expect(targetSummary([{ kind: "artifact", id: "a1" }])).toBe("1 artifact")
    expect(
      targetSummary([
        { kind: "artifact", id: "a1" },
        { kind: "artifact", id: "a2" },
        { kind: "tag", tag: "weekly" },
      ]),
    ).toBe("2 artifacts, 1 tag")
    expect(
      targetSummary([
        { kind: "collection", id: "c1" },
        { kind: "collection", id: "c2" },
      ]),
    ).toBe("2 collections")
  })
})

describe("runWrites", () => {
  it("maps each write to its verb: created, proposed (from decision), or revised", () => {
    const meta = JSON.stringify({
      writes: [
        { short_id: "d1", decision: "live_publish_with_review", created: false },
        { short_id: "d2", decision: "proposal", created: false },
        { short_id: "d3", decision: "proposal", created: true },
      ],
    })
    expect(runWrites(meta)).toEqual([
      { shortId: "d1", verb: "revised" },
      { shortId: "d2", verb: "proposed" },
      { shortId: "d3", verb: "created" },
    ])
  })
  it("drops writes with no artifact (shadow), and tolerates every junk shape", () => {
    expect(
      runWrites(
        JSON.stringify({ writes: [{ short_id: null }, { short_id: "" }, { decision: "x" }] }),
      ),
    ).toEqual([])
    expect(runWrites(null)).toEqual([])
    expect(runWrites("not json")).toEqual([])
    expect(runWrites(JSON.stringify({ outcome: "answered" }))).toEqual([]) // no writes key
    expect(runWrites(JSON.stringify({ writes: "nope" }))).toEqual([])
  })
})
