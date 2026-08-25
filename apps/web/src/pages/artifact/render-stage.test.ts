import { describe, expect, it } from "vitest"
import { runtimeFailureCopy, type UpdateCueState, updateCue } from "./render-stage"

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

describe("runtimeFailureCopy", () => {
  it("gives editors the sandbox-storage repair without exposing exception details", () => {
    const copy = runtimeFailureCopy("sandbox-storage", true)
    expect(copy.title).toContain("Browser storage")
    expect(copy.description).toContain("derive.shared")
    expect(copy.description).not.toContain("SecurityError")
  })

  it("keeps reader-facing failures neutral", () => {
    expect(runtimeFailureCopy("sandbox-storage", false)).toEqual({
      title: "This artifact couldn’t start",
      description: "Its author needs to update it for Derive’s secure sandbox.",
    })
    expect(runtimeFailureCopy("script-error", false).description).not.toContain("stack")
  })
})
