import { describe, expect, it } from "vitest"
import { effectiveDocH, normalizePref, placePeer, type ViewerGeom } from "./cursors"

// The document-anchored placement math: a peer's eased document position mapped
// against THIS viewer's scroll into a screen position, or classified as an
// off-screen (above/below) peer for the edge indicator. Pure, so we hammer the
// boundaries here instead of through the flaky rAF loop.

describe("effectiveDocH", () => {
  it("uses the reported document height when present", () => {
    expect(effectiveDocH(2000, 800)).toBe(2000)
    expect(effectiveDocH(1500, 0)).toBe(1500)
  })
  it("falls back to the visible height until geometry is reported", () => {
    expect(effectiveDocH(0, 800)).toBe(800)
  })
  it("is never 0 (so we never divide/scale by zero)", () => {
    expect(effectiveDocH(0, 0)).toBe(1)
  })
})

describe("placePeer", () => {
  const geom = (over: Partial<ViewerGeom> = {}): ViewerGeom => ({
    scrollY: 0,
    docH: 2000,
    viewH: 800,
    ...over,
  })

  it("places an in-view peer at its document position, unshifted at scroll 0", () => {
    expect(placePeer(120, 500, geom())).toEqual({ onScreen: true, x: 120, y: 500 })
  })

  it("passes x through unchanged (x does not scroll)", () => {
    const p = placePeer(333, 100, geom())
    expect(p.x).toBe(333)
  })

  it("treats the exact top and bottom edges as on-screen", () => {
    // cyDoc === scrollY -> y === 0 (top edge)
    expect(placePeer(0, 300, geom({ scrollY: 300 }))).toMatchObject({ onScreen: true, y: 0 })
    // y === viewH (bottom edge)
    expect(placePeer(0, 800, geom())).toMatchObject({ onScreen: true, y: 800 })
  })

  it("classifies a peer one pixel past the top as above", () => {
    expect(placePeer(0, 299, geom({ scrollY: 300 }))).toEqual({
      onScreen: false,
      side: "above",
      x: 0,
      y: -1,
    })
  })

  it("classifies a peer one pixel past the bottom as below", () => {
    expect(placePeer(0, 801, geom())).toEqual({
      onScreen: false,
      side: "below",
      x: 0,
      y: 801,
    })
  })

  it("glues a peer to the document as the viewer scrolls (the whole point)", () => {
    const peerDocY = 1000 // a peer 1000px down the document
    // At the top, they're below the 800px viewport.
    expect(placePeer(0, peerDocY, geom({ scrollY: 0 }))).toMatchObject({
      onScreen: false,
      side: "below",
    })
    // Scroll down 400px and they enter view, shifted up by exactly the scroll.
    expect(placePeer(0, peerDocY, geom({ scrollY: 400 }))).toEqual({
      onScreen: true,
      x: 0,
      y: 600,
    })
    // Scroll past them and they're now above the viewport.
    expect(placePeer(0, peerDocY, geom({ scrollY: 1100 }))).toMatchObject({
      onScreen: false,
      side: "above",
    })
  })
})

describe("document mapping (effectiveDocH + placePeer, as the rAF loop composes them)", () => {
  // Mirror the loop: a peer's normalized y -> document pixels -> screen placement.
  const map = (yNorm: number, reportedDocH: number, layerH: number, scrollY: number) =>
    placePeer(0, yNorm * effectiveDocH(reportedDocH, layerH), {
      scrollY,
      docH: reportedDocH,
      viewH: layerH,
    })

  it("never pushes a peer off-screen in a document shorter than the viewport", () => {
    // docH 400 < viewH 800: even a peer at the very bottom of the doc is in view.
    expect(map(0.99, 400, 800, 0)).toMatchObject({ onScreen: true })
  })

  it("classifies a peer deep in a tall document as below, then on-screen once scrolled", () => {
    expect(map(0.6, 5000, 800, 0)).toMatchObject({ onScreen: false, side: "below" })
    expect(map(0.6, 5000, 800, 2400)).toEqual({ onScreen: true, x: 0, y: 600 })
  })

  it("still shows a peer (viewport-mapped) before the frame has reported geometry", () => {
    // reportedDocH 0 -> fall back to the layer height, so y=0.5 lands mid-viewport.
    expect(map(0.5, 0, 800, 0)).toEqual({ onScreen: true, x: 0, y: 400 })
  })
})

describe("normalizePref (hidden is the only preference)", () => {
  it("defaults hidden to false for empty / garbage / nullish input", () => {
    expect(normalizePref({}).hidden).toBe(false)
    expect(normalizePref(null).hidden).toBe(false)
    expect(normalizePref(undefined).hidden).toBe(false)
    expect(normalizePref("nope").hidden).toBe(false)
  })
  it("only treats a strict boolean true as hidden", () => {
    expect(normalizePref({ hidden: true }).hidden).toBe(true)
    expect(normalizePref({ hidden: "yes" }).hidden).toBe(false)
    expect(normalizePref({ hidden: 1 }).hidden).toBe(false)
  })
})
