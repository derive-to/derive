import { describe, expect, it } from "vitest"
import {
  BOOT_MAX_TRIES,
  bootStatusCopy,
  bootTimeoutDecision,
  type UpdateCueState,
  updateCue,
} from "./render-stage"

// The soft "Updated · vN" cue's decision, pinned after it shipped a phantom: the render
// stage stays mounted while the sibling switcher pages between artifacts, and a bare
// version comparison read "memo v1 → sibling v5" as "someone just published v5" — an
// Updated pill floating over a document nobody had touched, which then sent its reader
// hunting for four versions that never existed.
describe("updateCue", () => {
  const step = (prev: UpdateCueState, subject: string, version?: number) =>
    updateCue(prev, subject, version)

  it("fires only when the SAME document steps up in place", () => {
    let s = step(null, "memo", 1)
    expect(s.fire).toBeNull() // first sight is not an update
    s = step(s.state, "memo", 2)
    expect(s.fire).toBe(2) // a peer published while watching — the one true case
  })

  it("never fires across a subject change — the shipped phantom", () => {
    let s = step(null, "memo", 1)
    // Page to a sibling that happens to sit at v5: a different document, not an update.
    s = step(s.state, "build-scope", 5)
    expect(s.fire).toBeNull()
    // …and the new subject becomes the baseline: its own step-up still fires.
    s = step(s.state, "build-scope", 6)
    expect(s.fire).toBe(6)
  })

  it("stays quiet on same-version renders and backward navigation", () => {
    let s = step(null, "memo", 3)
    s = step(s.state, "memo", 3)
    expect(s.fire).toBeNull()
    s = step(s.state, "memo", 2) // viewing an earlier version
    expect(s.fire).toBeNull()
    // Returning to current from a past version is not a publish either.
    s = step(s.state, "memo", 3)
    expect(s.fire).toBeNull()
  })

  it("keeps its baseline through a not-yet-known source, per subject", () => {
    let s = step(null, "memo", 4)
    s = step(s.state, "memo", undefined) // src briefly unknown (seed row, retry)
    expect(s.state).toEqual({ subject: "memo", version: 4 })
    s = step(s.state, "memo", 5)
    expect(s.fire).toBe(5)
    // A subject change while the source is unknown drops the baseline entirely —
    // whatever version lands next is first sight, not an update.
    s = step(s.state, "other", undefined)
    expect(s.state).toBeNull()
    s = step(s.state, "other", 9)
    expect(s.fire).toBeNull()
  })
})

// Boot timeout after publish often races a still-warm render. Auto-retry a few times
// with growing backoff; only the exhausted attempt is terminal (manual Retry).
describe("bootTimeoutDecision", () => {
  it("retries with growing backoff, then fails once tries are exhausted", () => {
    expect(BOOT_MAX_TRIES).toBe(3)
    const sequence = Array.from({ length: BOOT_MAX_TRIES }, (_, i) => bootTimeoutDecision(i))
    expect(sequence).toEqual([
      { action: "retry", delayMs: 1_000 },
      { action: "retry", delayMs: 2_000 },
      { action: "fail" },
    ])
  })

  it("stays terminal past the last budgeted try", () => {
    expect(bootTimeoutDecision(BOOT_MAX_TRIES)).toEqual({ action: "fail" })
    expect(bootTimeoutDecision(BOOT_MAX_TRIES + 4)).toEqual({ action: "fail" })
  })
})

describe("bootStatusCopy", () => {
  it("keeps the calm first-paint label until a retry path engages", () => {
    expect(bootStatusCopy(0, false)).toBe("Loading preview…")
  })

  it("names the extended wait after a timeout or on a later try", () => {
    expect(bootStatusCopy(0, true)).toBe("Still rendering…")
    expect(bootStatusCopy(1, false)).toBe("Still rendering…")
    expect(bootStatusCopy(2, true)).toBe("Still rendering…")
  })
})
