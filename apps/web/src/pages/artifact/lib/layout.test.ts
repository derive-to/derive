import { describe, expect, it } from "vitest"
import type { Comment } from "@/api"
import {
  type BucketInput,
  bucketThreads,
  clamp,
  consumeWheel,
  groupThreads,
  layoutPins,
  normalizeWheel,
  pinOffsetBounds,
} from "./layout"

describe("clamp", () => {
  it("bounds a value to [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
})

describe("layoutPins", () => {
  const heights = { a: 100, b: 100 }

  it("stacks overlapping cards apart by the gap, top-down", () => {
    const pos = layoutPins(
      [
        { id: "a", desiredY: 0 },
        { id: "b", desiredY: 10 },
      ],
      heights,
      null,
      8,
    )
    expect(pos.a).toBe(0)
    // b wanted 10 but a occupies 0..100, so b is pushed to 100 + gap.
    expect(pos.b).toBe(108)
  })

  it("pins the active card to its exact Y and pushes a neighbour above out of the way", () => {
    const pos = layoutPins(
      [
        { id: "a", desiredY: 0 },
        { id: "b", desiredY: 10 },
      ],
      heights,
      "b",
      8,
    )
    expect(pos.b).toBe(10) // pinned to its desired Y
    expect(pos.a).toBe(-98) // pushed up: 10 - 8(gap) - 100(height)
  })

  it("pins the active first card and flows the rest below it", () => {
    const pos = layoutPins(
      [
        { id: "a", desiredY: 0 },
        { id: "b", desiredY: 50 },
      ],
      heights,
      "a", // active is first in sort order, so the below-neighbour pass runs
      8,
    )
    expect(pos.a).toBe(0) // pinned to its desired Y
    expect(pos.b).toBe(108) // below a (0..100) + gap
  })
})

describe("groupThreads", () => {
  it("buckets comments by thread_id, preserving order", () => {
    const c = (id: string, thread_id: string) => ({ id, thread_id }) as unknown as Comment
    const groups = groupThreads([c("1", "t1"), c("2", "t2"), c("3", "t1")])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.map((x) => x.id)).toEqual(["1", "3"])
    expect(groups[1]?.map((x) => x.id)).toEqual(["2"])
  })
})

describe("bucketThreads", () => {
  // A root comment for thread `tid` with a text anchor to `quote` (or unanchored).
  const thread = (tid: string, over: Partial<Comment> = {}): Comment =>
    ({
      id: tid,
      thread_id: tid,
      state: "open",
      anchor: JSON.stringify({ exact: "some text" }),
      anchored: true,
      ...over,
    }) as unknown as Comment
  const base: Omit<BucketInput, "comments"> = {
    docLive: true,
    deck: null,
    inDoc: {},
    landedSlides: {},
    anchorTops: {},
  }

  it("pins an anchored, present thread at its highlight's doc-absolute top", () => {
    const r = bucketThreads({
      ...base,
      comments: [thread("t1")],
      inDoc: { t1: true },
      anchorTops: { t1: 500 },
    })
    expect(r.pinned).toHaveLength(1)
    // Doc-absolute: scroll is the pin layer's business, never the bucketer's.
    expect(r.pinned[0]?.desiredY).toBe(500)
    expect(r.pinned[0]?.located).toBe(true)
    expect(r.general).toHaveLength(0)
    expect(r.openCount).toBe(1)
  })

  it("sends an unanchored (general) thread to the drawer, never the margin", () => {
    const r = bucketThreads({ ...base, comments: [thread("t1", { anchor: null })] })
    expect(r.pinned).toHaveLength(0)
    expect(r.general).toHaveLength(1)
  })

  it("keeps an outdated thread active (general), out of the resolved drawer", () => {
    // Its quote is gone (not inDoc, anchored:false), so it can't pin — but it stays
    // visible for triage rather than being filed as resolved.
    const r = bucketThreads({
      ...base,
      comments: [thread("t1", { state: "outdated", anchored: false })],
    })
    expect(r.resolvedThreads).toHaveLength(0)
    expect(r.general).toHaveLength(1)
    expect(r.openCount).toBe(1)
  })

  it("separates resolved threads and excludes them from the open count", () => {
    const r = bucketThreads({
      ...base,
      comments: [thread("t1"), thread("t2", { state: "resolved" })],
      inDoc: { t1: true },
      anchorTops: { t1: 10 },
    })
    expect(r.openCount).toBe(1)
    expect(r.resolvedThreads).toHaveLength(1)
    expect(r.pinned).toHaveLength(1)
  })

  it("does not pin while the doc is not live (editing / diffing) — all go general", () => {
    const r = bucketThreads({
      ...base,
      docLive: false,
      comments: [thread("t1")],
      inDoc: { t1: true },
      anchorTops: { t1: 10 },
    })
    expect(r.pinned).toHaveLength(0)
    expect(r.general).toHaveLength(1)
  })

  it("falls back to the server `anchored` flag when the frame hasn't reported inDoc", () => {
    // No inDoc entry (the frame never got sent this thread): use `anchored:false` so a
    // stale anchor lands in general as an orphan, not pinned invisibly.
    const orphan = bucketThreads({
      ...base,
      comments: [thread("t1", { anchored: false })],
      anchorTops: { t1: 10 },
    })
    expect(orphan.pinned).toHaveLength(0)
    expect(orphan.general).toHaveLength(1)
  })

  it("on a deck, pins a thread only on its landed slide and drawers it elsewhere", () => {
    const onSlide2 = (tid: string) =>
      thread(tid, { anchor: JSON.stringify({ exact: "q", slide: 2 }) })
    const here = bucketThreads({
      ...base,
      comments: [onSlide2("t1")],
      deck: { i: 2, total: 5 },
      inDoc: { t1: true },
      landedSlides: { t1: 2 },
      anchorTops: { t1: 40 },
    })
    expect(here.pinned).toHaveLength(1)
    const elsewhere = bucketThreads({
      ...base,
      comments: [onSlide2("t1")],
      deck: { i: 0, total: 5 },
      inDoc: { t1: true },
      landedSlides: { t1: 2 },
      anchorTops: { t1: 40 },
    })
    expect(elsewhere.pinned).toHaveLength(0)
    expect(elsewhere.general).toHaveLength(1)
  })
})

describe("normalizeWheel", () => {
  it("passes pixel-mode deltas through and scales line/page modes", () => {
    expect(normalizeWheel(120, 0, 800)).toBe(120)
    expect(normalizeWheel(3, 1, 800)).toBe(48) // Firefox line-mode mice: ~16px/line
    expect(normalizeWheel(1, 2, 800)).toBe(800) // page mode
  })
})

describe("pinOffsetBounds", () => {
  const base = { minY: 200, maxBottom: 3000, activeY: null, datum: -80, scrollY: 500, zoneH: 600 }

  it("allows positive offset up to the stack's overflow below the zone", () => {
    // Stack bottom at zone-local 3000 - 80 - 500 = 2420; zone shows 600.
    expect(pinOffsetBounds(base)).toEqual({ min: 0, max: 1820 })
  })

  it("never allows negative offset mid-document without an active item", () => {
    // Wheel-up mid-doc must forward to the document, not slide cards down.
    expect(pinOffsetBounds({ ...base, minY: -400 }).min).toBe(0)
  })

  it("opens the above-zone band at the doc top", () => {
    // At scrollY 0 the topmost card sits at 20 - 80 = -60 (zone starts below the
    // iframe top by the header/review-card band) — reachable only by negative offset.
    const b = pinOffsetBounds({ ...base, minY: 20, scrollY: 0 })
    expect(b.min).toBe(-60)
  })

  it("extends the floor to keep a clipped ACTIVE item revealable at any scroll", () => {
    // A composer opened on a selection near the viewport's top: its layer Y is
    // 400 - 80 - 500 = -180; the clamp-on-notify must not crush its reveal.
    const b = pinOffsetBounds({ ...base, activeY: 400 })
    expect(b.min).toBe(-180)
  })

  it("clamps both bounds at zero when everything already fits", () => {
    expect(pinOffsetBounds({ ...base, maxBottom: 700, scrollY: 200 })).toEqual({ min: 0, max: 0 })
  })
})

describe("consumeWheel", () => {
  it("absorbs a delta fully while the offset has room", () => {
    expect(consumeWheel(0, 100, 0, 500)).toEqual({ offset: 100, forward: 0 })
  })

  it("splits the tick that exhausts the room, forwarding the remainder", () => {
    expect(consumeWheel(450, 100, 0, 500)).toEqual({ offset: 500, forward: 50 })
  })

  it("forwards everything when the offset is pinned at a bound", () => {
    expect(consumeWheel(500, 100, 0, 500)).toEqual({ offset: 500, forward: 100 })
    expect(consumeWheel(0, -100, 0, 500)).toEqual({ offset: 0, forward: -100 })
  })

  it("unwinds a positive offset before forwarding an upward gesture", () => {
    expect(consumeWheel(30, -100, 0, 500)).toEqual({ offset: 0, forward: -70 })
  })

  it("consumes into the negative band when the floor is open (doc at top)", () => {
    expect(consumeWheel(0, -100, -60, 500)).toEqual({ offset: -60, forward: -40 })
  })
})
