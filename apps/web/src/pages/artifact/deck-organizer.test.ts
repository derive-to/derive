import { describe, expect, it } from "vitest"
import { compileSlideOps, type OrganizerSlide, restoreSlideIndex } from "./deck-organizer"

const base = (key: string, created: number): OrganizerSlide => ({
  key,
  label: key,
  kind: "base",
  created,
})

describe("compileSlideOps", () => {
  it("removes and reorders against the same starting positions", () => {
    const a = base("a", 0)
    const b = base("b", 1)
    const c = base("c", 2)
    expect(compileSlideOps([a, b, c], [c, a], [{ ...b, restoreAt: 1 }])).toEqual([
      { op: "delete", at: 2 },
      { op: "move", from: 2, to: 1 },
    ])
  })

  it("materializes a new blank slide before moving it into place", () => {
    const a = base("a", 0)
    const b = base("b", 1)
    const fresh: OrganizerSlide = {
      key: "new",
      label: "New slide",
      kind: "insert",
      created: 2,
    }
    expect(compileSlideOps([a, b], [a, fresh, b], [])).toEqual([
      { op: "insert", at: 3 },
      { op: "move", from: 3, to: 2 },
    ])
  })

  it("keeps a copy even when its source is in Trash", () => {
    const a = base("a", 0)
    const b = base("b", 1)
    const copy: OrganizerSlide = {
      key: "copy-b",
      label: "b copy",
      kind: "duplicate",
      sourceKey: "b",
      created: 2,
    }
    expect(compileSlideOps([a, b], [copy, a], [{ ...b, restoreAt: 1 }])).toEqual([
      { op: "duplicate", at: 2 },
      { op: "delete", at: 2 },
      { op: "move", from: 2, to: 1 },
    ])
  })

  it("restores multiple trashed slides by their surviving neighbors", () => {
    const a = base("a", 0)
    const b = { ...base("b", 1), restoreAfterKey: "a", restoreBeforeKey: "c", restoreAt: 1 }
    const c = { ...base("c", 2), restoreAfterKey: "a", restoreBeforeKey: "d", restoreAt: 1 }
    const d = base("d", 3)

    // Restore in reverse removal order: C goes before D; B then finds C and goes before it.
    const afterC = [a, d]
    afterC.splice(restoreSlideIndex(c, afterC), 0, c)
    expect(afterC.map((slide) => slide.key)).toEqual(["a", "c", "d"])
    afterC.splice(restoreSlideIndex(b, afterC), 0, b)
    expect(afterC.map((slide) => slide.key)).toEqual(["a", "b", "c", "d"])
  })
})
