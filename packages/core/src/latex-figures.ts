/**
 * Fitting a paper's source under the bundle cap by shrinking its figures.
 *
 * A source archive fetched from arXiv is whatever the authors uploaded, and what makes it
 * large is almost always figures carrying far more pixels than the rendered page shows
 * (a `\linewidth` figure is about 800 CSS px wide, 1600 at a 2x display). Derive's stance
 * on a PERSON's upload is to name the cost of a heavy image rather than re-encode it
 * (advisories.ts). An arXiv import is different: a machine-fetched third-party archive
 * that otherwise cannot exist on Derive at all. So, only when the bundle would not fit,
 * the raster figures are re-encoded in place, largest first, to a bounded long side, and
 * every change is written into the import's notes.
 *
 * This module is the policy: which files, in what order, to what size, when to stop. The
 * codec is injected (`FigureShrinker`), because the domain kernel has no image library
 * and the Workers tier cannot run one; without a shrinker the pass is only the size check.
 * A shrunk figure keeps its path and its format: the renderer resolves a figure by its
 * exact path when the reference carries an extension, so a rename would lose the figure.
 */

export interface FigureShrinkInput {
  path: string
  bytes: Uint8Array
  /** The longest side the result may have, in pixels. */
  maxSide: number
  /** JPEG/WebP quality; PNG keeps its format at maximum compression. */
  quality: number
}

/** Re-encode a figure in the same format at a bounded size. Null means "leave it": the
 *  bytes could not be read, the format is not one the tool re-encodes, or the tool is
 *  unavailable. A result larger than the input is discarded by the caller. */
export type FigureShrinker = (input: FigureShrinkInput) => Promise<Uint8Array | null>

/** The formats the page renders and a codec re-encodes in place. GIF may be animated,
 *  SVG is vector, TIFF and BMP never render, PDF and EPS cannot be opened: all untouched. */
export const RASTER_FIGURE = /\.(png|jpe?g|webp)$/i

/** A figure under this is not worth re-encoding: whatever it holds, it is not what makes
 *  the bundle heavy, and re-encoding would only change bytes for nothing. */
export const MIN_SHRINK_BYTES = 64 * 1024

export interface FigurePass {
  maxSide: number
  quality: number
}

/** Each pass bounds the long side a little more. 1600 is the page's 2x column; 900 is
 *  still a legible figure and about a fifth of the bytes of 2000 px. */
export const FIGURE_PASSES: readonly FigurePass[] = [
  { maxSide: 1600, quality: 82 },
  { maxSide: 1200, quality: 78 },
  { maxSide: 900, quality: 72 },
]

export interface FitBundleOptions {
  /** The most the published bundle may hold, summed over its files. */
  cap: number
  /** The codec; null (the Workers tier) makes this a size check only. */
  shrink: FigureShrinker | null
  passes?: readonly FigurePass[]
  /** How many figures are in the codec at once. */
  concurrency?: number
}

export interface FitBundleResult {
  files: Record<string, Uint8Array>
  fits: boolean
  /** Total bytes before and after. */
  before: number
  after: number
  /** How many figures were re-encoded. */
  shrunk: number
  /** The pass that made it fit (0-based), null when none did or none was needed. */
  pass: number | null
  /** What happened, for the import notes. Empty when nothing was touched. */
  notes: string[]
  /** The largest files left, for a failure that names what stayed big. */
  largest: { path: string; bytes: number }[]
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`
const total = (files: Record<string, Uint8Array>): number =>
  Object.values(files).reduce((n, f) => n + f.byteLength, 0)

/** Run `work` over `items` with at most `limit` in flight, in order of start. */
const pooled = async <T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
}

/**
 * Shrink the bundle's raster figures until it fits the cap, or say what still does not.
 * Files under the cap come back untouched; over it, each pass re-encodes the largest
 * figures first and stops the moment the total is under the cap.
 */
export const fitBundleBytes = async (
  input: Record<string, Uint8Array>,
  opts: FitBundleOptions,
): Promise<FitBundleResult> => {
  const files = { ...input }
  const before = total(files)
  const largest = () =>
    Object.entries(files)
      .map(([path, data]) => ({ path, bytes: data.byteLength }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3)
  if (before <= opts.cap)
    return {
      files,
      fits: true,
      before,
      after: before,
      shrunk: 0,
      pass: null,
      notes: [],
      largest: [],
    }
  const passes = opts.passes ?? FIGURE_PASSES
  const shrunkPaths = new Set<string>()
  let after = before
  let pass: number | null = null
  if (opts.shrink) {
    const shrink = opts.shrink
    for (let i = 0; i < passes.length && after > opts.cap; i++) {
      const p = passes[i] as FigurePass
      const candidates = Object.keys(files)
        .filter(
          (path) => RASTER_FIGURE.test(path) && (files[path]?.byteLength ?? 0) >= MIN_SHRINK_BYTES,
        )
        .sort((a, b) => (files[b]?.byteLength ?? 0) - (files[a]?.byteLength ?? 0))
      await pooled(candidates, opts.concurrency ?? 4, async (path) => {
        if (after <= opts.cap) return
        const current = files[path]
        if (!current) return
        let result: Uint8Array | null
        try {
          result = await shrink({ path, bytes: current, maxSide: p.maxSide, quality: p.quality })
        } catch {
          result = null
        }
        if (!result || result.byteLength >= current.byteLength) return
        after -= current.byteLength - result.byteLength
        files[path] = result
        shrunkPaths.add(path)
      })
      if (after <= opts.cap) pass = i
    }
  }
  const fits = after <= opts.cap
  const notes: string[] = []
  if (shrunkPaths.size > 0) {
    const side = (passes[pass ?? passes.length - 1] as FigurePass).maxSide
    notes.push(
      `shrank ${shrunkPaths.size} ${shrunkPaths.size === 1 ? "figure" : "figures"} to at most ${side} px on the long side (${mb(before)} → ${mb(after)})`,
    )
  }
  return { files, fits, before, after, shrunk: shrunkPaths.size, pass, notes, largest: largest() }
}
