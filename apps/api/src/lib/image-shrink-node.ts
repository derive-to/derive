// The figure codec for the arXiv importer, Node only. sharp is a native module (libvips):
// it runs on the self-host and Fly tiers, never in the Workers isolate, so this file is
// imported from node.ts alone (a dependency-cruiser rule keeps it that way) and loads the
// module lazily, so a platform without a prebuilt binary imports papers as before, just
// without shrinking. The decision of WHAT to shrink and WHEN lives in @derive/core
// (fitBundleBytes); this is only "make these bytes smaller in the same format".
import type { FigureShrinker } from "@derive/core"
import { log } from "../log"

type Sharp = typeof import("sharp").default

/** The most pixels one figure may decode to; past this sharp refuses instead of allocating. */
const MAX_INPUT_PIXELS = 80_000_000
const PER_IMAGE_TIMEOUT_MS = 10_000

let loading: Promise<Sharp | null> | null = null
const loadSharp = (): Promise<Sharp | null> => {
  loading ??= import("sharp")
    .then((mod) => {
      const sharp = mod.default
      // Two libvips threads at a time and no operation cache: an import is a burst of
      // hundreds of figures on a shared server, and the tick's own pool already bounds
      // how many are in flight.
      sharp.concurrency(2)
      sharp.cache(false)
      return sharp
    })
    .catch((error) => {
      log.warn("figure shrinking unavailable: sharp did not load", {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })
  return loading
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("figure shrink timed out")), ms)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })

/** Re-encode a raster figure in the format its extension says (the page serves it by
 *  that extension), bounded to `maxSide`, never enlarged, EXIF orientation applied. */
export const sharpShrinker = (): FigureShrinker => async (input) => {
  const sharp = await loadSharp()
  if (!sharp) return null
  const ext = /\.([a-z0-9]+)$/i.exec(input.path)?.[1]?.toLowerCase()
  try {
    let pipeline = sharp(input.bytes, {
      failOn: "none",
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
    })
      .rotate()
      .resize({
        width: input.maxSide,
        height: input.maxSide,
        fit: "inside",
        withoutEnlargement: true,
      })
    if (ext === "jpg" || ext === "jpeg")
      pipeline = pipeline.jpeg({ quality: input.quality, mozjpeg: true })
    else if (ext === "png") pipeline = pipeline.png({ compressionLevel: 9, effort: 7 })
    else if (ext === "webp") pipeline = pipeline.webp({ quality: input.quality })
    else return null
    const out = await withTimeout(pipeline.toBuffer(), PER_IMAGE_TIMEOUT_MS)
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  } catch {
    return null
  }
}
