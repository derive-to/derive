import { describe, expect, it } from "vitest"
import {
  CURSOR_COLORS,
  type CursorPref,
  defaultPrefFor,
  effectiveDocH,
  normalizePref,
  placePeer,
  type ViewerGeom,
} from "./cursors"

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

describe("normalizePref / defaultPrefFor (hidden field)", () => {
  const fb: CursorPref = { color: CURSOR_COLORS[0], kind: "arrow", emoji: "👆", hidden: false }
  it("defaults hidden to false", () => {
    expect(defaultPrefFor("seed").hidden).toBe(false)
    expect(normalizePref({}, fb).hidden).toBe(false)
  })
  it("only treats a strict true as hidden", () => {
    expect(normalizePref({ hidden: true }, fb).hidden).toBe(true)
    expect(normalizePref({ hidden: "yes" }, fb).hidden).toBe(false)
    expect(normalizePref({ hidden: 1 }, fb).hidden).toBe(false)
  })
})
