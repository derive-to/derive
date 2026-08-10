import { describe, expect, it } from "vitest"
import { clearStaleEdit, noteStalePublish, staleEditCopy } from "./stale-edit"

// Concurrent-publish latch: set only while editing, bump on later publishes, clear
// on save/exit. The chip reads this; the toast no longer is the sole signal.
describe("noteStalePublish", () => {
  it("latches a version only while an edit is active", () => {
    expect(noteStalePublish(null, false, 12)).toBeNull()
    expect(noteStalePublish(null, true, 12)).toBe(12)
  })

  it("ignores publishes when not editing even if a prior latch exists", () => {
    // A publish after exit must not re-arm; clearing is the edit-end path's job.
    expect(noteStalePublish(12, false, 13)).toBe(12)
  })

  it("bumps to the newest version when several land mid-edit", () => {
    let s = noteStalePublish(null, true, 4)
    s = noteStalePublish(s, true, 5)
    expect(s).toBe(5)
    s = noteStalePublish(s, true, 3) // out-of-order / replay stays at the high-water mark
    expect(s).toBe(5)
  })

  it("treats an unnumbered publish as 'a new version' until a concrete one arrives", () => {
    expect(noteStalePublish(null, true, undefined)).toBe(0)
    expect(noteStalePublish(0, true, 9)).toBe(9)
    // A later unnumbered event must not wipe a known version.
    expect(noteStalePublish(9, true, undefined)).toBe(9)
  })
})

describe("clearStaleEdit", () => {
  it("drops the latch on save or exit", () => {
    expect(clearStaleEdit()).toBeNull()
    expect(noteStalePublish(clearStaleEdit(), true, 2)).toBe(2)
  })
})

describe("staleEditCopy", () => {
  it("is silent when nothing is stale", () => {
    expect(staleEditCopy(null, "inline")).toBeNull()
    expect(staleEditCopy(null, "source")).toBeNull()
  })

  it("names the version and the surface's save path", () => {
    expect(staleEditCopy(12, "inline")).toBe(
      "v12 was published while you've been editing — saving re-checks your edits against it.",
    )
    expect(staleEditCopy(12, "source")).toBe(
      "v12 was published while you've been editing — publishing this edit will replace it.",
    )
  })

  it("falls back when the SSE carried no version number", () => {
    expect(staleEditCopy(0, "inline")).toMatch(/^A new version was published/)
  })
})
