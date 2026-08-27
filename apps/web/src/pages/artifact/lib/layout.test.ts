import { describe, expect, it } from "vitest"
import type { Comment } from "@/api"
import { type BucketInput, bucketThreads, groupThreads } from "./layout"

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
