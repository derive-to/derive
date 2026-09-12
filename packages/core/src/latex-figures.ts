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
 * codec is injected (`FigureShrinker`), because the domain kernel has no image library:
 * sharp on Node, a headless browser on the Workers tier, and without one the pass is only
 * the size check. So is where the figures are (`FigureStore`): the policy chooses from
 * sizes alone, and reads a figure only to hand it to the codec, so a caller that keeps its
 * files in the blob store never holds more of them than the codec is working on.
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

/** Where the bundle's files are, when the caller does not hold them: how big each is, how
 *  to read one for the codec, and how to keep what the codec returns. */
export interface FigureStore<F> {
  size(file: F): number
  load(file: F): Promise<Uint8Array | null>
  save(bytes: Uint8Array): Promise<F>
}

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
  /** The codec; null makes this a size check only. */
  shrink: FigureShrinker | null
  passes?: readonly FigurePass[]
  /** How many figures are in the codec at once. */
  concurrency?: number
  /** A figure larger than this is never loaded for the codec: what a caller with little
   *  memory can afford to hold. */
  maxInputBytes?: number
  /** Called before each figure goes to the codec, so a long pass can say it is alive. */
  onFigure?: () => Promise<void>
  /** Checked before each figure; once it answers true, no more are tried. */
  outOfTime?: () => boolean
}

export interface FitBundleResult<F = Uint8Array> {
  files: Record<string, F>
  fits: boolean
  /** Total bytes before and after. */
  before: number
  after: number
  /** How many figures were re-encoded. */
  shrunk: number
  /** The pass that made it fit (0-based), null when none did or none was needed. */
  pass: number | null
  /** Whether shrinking stopped because it ran out of time. */
  stopped: boolean
  /** What happened, for the import notes. Empty when nothing was touched. */
  notes: string[]
  /** The largest files left, for a failure that names what stayed big. */
  largest: { path: string; bytes: number }[]
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

const BYTES: FigureStore<Uint8Array> = {
  size: (bytes) => bytes.byteLength,
  load: async (bytes) => bytes,
  save: async (bytes) => bytes,
}

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
 * figures first and stops the moment the total is under the cap. Files held elsewhere
 * need a `store`.
 */
export function fitBundleBytes(
  input: Record<string, Uint8Array>,
  opts: FitBundleOptions,
): Promise<FitBundleResult>
export function fitBundleBytes<F>(
  input: Record<string, F>,
  opts: FitBundleOptions & { store: FigureStore<F> },
): Promise<FitBundleResult<F>>
export async function fitBundleBytes<F>(
  input: Record<string, F>,
  opts: FitBundleOptions & { store?: FigureStore<F> },
): Promise<FitBundleResult<F>> {
  const store = opts.store ?? (BYTES as unknown as FigureStore<F>)
  const files = { ...input }
  const sizeAt = (path: string): number => {
    const file = files[path]
    return file === undefined ? 0 : store.size(file)
  }
  const before = Object.keys(files).reduce((n, path) => n + sizeAt(path), 0)
  const largest = () =>
    Object.keys(files)
      .map((path) => ({ path, bytes: sizeAt(path) }))
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
      stopped: false,
      notes: [],
      largest: [],
    }
  const passes = opts.passes ?? FIGURE_PASSES
  const maxInput = opts.maxInputBytes ?? Number.POSITIVE_INFINITY
  const shrunkPaths = new Set<string>()
  let after = before
  let pass: number | null = null
  let stopped = false
  if (opts.shrink) {
    const shrink = opts.shrink
    for (let i = 0; i < passes.length && after > opts.cap && !stopped; i++) {
      const p = passes[i] as FigurePass
      const candidates = Object.keys(files)
        .filter((path) => {
          const size = sizeAt(path)
          return RASTER_FIGURE.test(path) && size >= MIN_SHRINK_BYTES && size <= maxInput
        })
        .sort((a, b) => sizeAt(b) - sizeAt(a))
      await pooled(candidates, opts.concurrency ?? 4, async (path) => {
        if (after <= opts.cap || stopped) return
        if (opts.outOfTime?.()) {
          stopped = true
          return
        }
        const current = files[path]
        if (current === undefined) return
        await opts.onFigure?.()
        const size = store.size(current)
        let result: Uint8Array | null
        try {
          const bytes = await store.load(current)
          result = bytes
            ? await shrink({ path, bytes, maxSide: p.maxSide, quality: p.quality })
            : null
        } catch {
          result = null
        }
        if (!result || result.byteLength >= size) return
        after -= size - result.byteLength
        files[path] = await store.save(result)
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
  return {
    files,
    fits,
    before,
    after,
    shrunk: shrunkPaths.size,
    pass,
    stopped,
    notes,
    largest: largest(),
  }
}
