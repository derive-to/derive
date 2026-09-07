import { describe, expect, it } from "vitest"
import { type FigureShrinker, fitBundleBytes, MIN_SHRINK_BYTES } from "./latex-figures"

// Sizes in KB throughout: the policy ignores figures under 64 KB, so the fixtures sit well
// above it and the arithmetic stays readable.
const KB = 1024
const kb = (n: number, fill = 1): Uint8Array => new Uint8Array(n * KB).fill(fill)
const sizesKb = (files: Record<string, Uint8Array>): Record<string, number> =>
  Object.fromEntries(Object.entries(files).map(([p, d]) => [p, d.byteLength / KB]))

/** A codec whose output is proportional to the pixel budget: maxSide² / 10 000 KB
 *  (256 KB at 1600, 144 at 1200, 81 at 900). */
const proportional: FigureShrinker = async ({ maxSide }) => kb((maxSide * maxSide) / 10_000, 9)

describe("fitBundleBytes", () => {
  it("leaves a bundle under the cap untouched and touches no non-raster file over it", async () => {
    const files = { "/main.tex": kb(10), "/fig/a.png": kb(500), "/fig/b.pdf": kb(500) }
    const under = await fitBundleBytes(files, { cap: 2000 * KB, shrink: proportional })
    expect(under).toMatchObject({
      fits: true,
      before: 1010 * KB,
      after: 1010 * KB,
      shrunk: 0,
      pass: null,
      notes: [],
    })
    expect(under.files["/fig/a.png"]).toBe(files["/fig/a.png"])
    // Over the cap because of the PDF: raster shrinking helps, the PDF stays as it is.
    const over = await fitBundleBytes(
      { "/main.tex": kb(10), "/fig/a.png": kb(500), "/fig/b.pdf": kb(800) },
      { cap: 1200 * KB, shrink: proportional },
    )
    expect(over.fits).toBe(true)
    expect(sizesKb(over.files)).toEqual({ "/main.tex": 10, "/fig/a.png": 256, "/fig/b.pdf": 800 })
    expect(over.shrunk).toBe(1)
    expect(over.pass).toBe(0)
    expect(over.notes).toEqual([
      "shrank 1 figure to at most 1600 px on the long side (1.3 MB → 1.0 MB)",
    ])
  })

  it("shrinks the largest figures first, stops the pass as soon as it fits, and skips small ones", async () => {
    const calls: string[] = []
    const shrink: FigureShrinker = async (x) => {
      calls.push(x.path)
      return proportional(x)
    }
    const r = await fitBundleBytes(
      {
        "/a.png": kb(900),
        "/b.jpg": kb(700),
        "/c.jpeg": kb(300),
        "/d.webp": kb(100),
        "/icon.png": new Uint8Array(MIN_SHRINK_BYTES - 1),
      },
      { cap: 1200 * KB, shrink, concurrency: 1 },
    )
    expect(r.fits).toBe(true)
    // 2000 → a: 256 (1356) → b: 256 (912) fits; c, d and the icon never enter the codec.
    expect(calls).toEqual(["/a.png", "/b.jpg"])
    expect(sizesKb(r.files)).toMatchObject({
      "/a.png": 256,
      "/b.jpg": 256,
      "/c.jpeg": 300,
      "/d.webp": 100,
    })
    expect(r.files["/icon.png"]?.byteLength).toBe(MIN_SHRINK_BYTES - 1)
    expect(r.after).toBe(912 * KB + MIN_SHRINK_BYTES - 1)
  })

  it("escalates through the passes and keeps the path and extension of every figure", async () => {
    const r = await fitBundleBytes(
      { "/figs/one.PNG": kb(1000), "/figs/two.jpg": kb(1000) },
      { cap: 300 * KB, shrink: proportional },
    )
    // Pass 0 leaves 512, pass 1 leaves 288: fits on the second pass.
    expect(r).toMatchObject({ fits: true, pass: 1, shrunk: 2, after: 288 * KB })
    expect(Object.keys(r.files).sort()).toEqual(["/figs/one.PNG", "/figs/two.jpg"])
    expect(r.notes[0]).toContain("2 figures to at most 1200 px")
  })

  it("keeps a file when the codec declines, throws, or returns something larger", async () => {
    const shrink: FigureShrinker = async ({ path, maxSide }) => {
      if (path === "/null.png") return null
      if (path === "/throw.png") throw new Error("boom")
      if (path === "/bigger.png") return kb(5000)
      return kb((maxSide * maxSide) / 10_000)
    }
    const input = {
      "/null.png": kb(500),
      "/throw.png": kb(500),
      "/bigger.png": kb(500),
      "/ok.png": kb(500),
    }
    const r = await fitBundleBytes(input, { cap: 1800 * KB, shrink })
    expect(sizesKb(r.files)).toEqual({
      "/null.png": 500,
      "/throw.png": 500,
      "/bigger.png": 500,
      "/ok.png": 256,
    })
    expect(r.files["/null.png"]).toBe(input["/null.png"])
    expect(r).toMatchObject({ fits: true, shrunk: 1 })
  })

  it("reports what still does not fit, naming the largest files, and shrinks nothing without a codec", async () => {
    const files = { "/main.tex": kb(10), "/figs/plot.pdf": kb(3000), "/figs/a.png": kb(400) }
    const r = await fitBundleBytes(files, { cap: 2000 * KB, shrink: proportional })
    expect(r.fits).toBe(false)
    expect(r.largest.map((x) => x.path)).toEqual(["/figs/plot.pdf", "/figs/a.png", "/main.tex"])
    expect(r.files["/figs/a.png"]?.byteLength).toBe(81 * KB)
    expect(r.pass).toBeNull()
    const edge = await fitBundleBytes(files, { cap: 2000 * KB, shrink: null })
    expect(edge).toMatchObject({ fits: false, shrunk: 0, notes: [], after: 3410 * KB })
    expect(edge.files).toEqual(files)
  })
})
