// The figure codec for the arXiv importer on the Workers tier. A Worker has no image library,
// but it has a browser: Cloudflare Browser Rendering, already bound for previews and exports.
// A figure is decoded and re-encoded inside a page (createImageBitmap, then an
// OffscreenCanvas), in the format its extension says and bounded to the long side it is
// asked for, as sharp does on Node. The decision of WHAT to shrink and WHEN lives in
// @derive/core (fitBundleBytes); this is only "make these bytes smaller in the same format".
//
// A figure crosses to the page and back in slices, so no message on the connection comes
// near its limit, and the Worker never holds a figure's base64 whole: at most the figure, one
// slice, and what comes back. The browser opens on the first figure a source needs shrunk,
// serves every figure after it through one page, and closes with the pass.
import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer"
import type { FigureShrinker, FigureShrinkInput } from "@derive/core"
import { imageDimensions } from "./image"

/** The most pixels one figure may decode to: the bound sharp is given on Node. */
const MAX_INPUT_PIXELS = 80_000_000
/** Figure bytes per slice sent to the page: 384 KB, which is 512 KB of base64. */
const SLICE_BYTES = 384 * 1024
/** Base64 characters per slice read back: a multiple of four, so each decodes alone. */
const SLICE_CHARS = 512 * 1024
const PER_FIGURE_MS = 15_000
/** How long an idle browser stays up between figures before Browser Rendering closes it. */
const KEEP_ALIVE_MS = 60_000

/** The parts of a Puppeteer page and browser the shrinker uses, so a test can stand in. */
export interface ShrinkPage {
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  close(): Promise<void>
}
export interface ShrinkBrowser {
  newPage(): Promise<ShrinkPage>
  close(): Promise<void>
}

export interface BrowserShrinker {
  shrink: FigureShrinker
  /** Whether the browser could not be used: a paper that does not fit then failed for a
   *  reason of the moment, not for its size. */
  readonly unavailable: boolean
  /** Close the browser, if one was opened. */
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let at = 0; at < bytes.byteLength; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

// ---- What runs inside the page ------------------------------------------------------
// Puppeteer sends these as source text, so each is self-contained: no imports, no module
// variables, and no functions declared inside.

/** Take one slice of the incoming figure; the first slice starts a new figure. */
const pageReceive = (arg: { piece: string; first: boolean }): number => {
  const g = globalThis as unknown as { __deriveIn?: string[]; __deriveOut?: string }
  if (arg.first || !g.__deriveIn) {
    g.__deriveIn = []
    g.__deriveOut = ""
  }
  g.__deriveIn.push(arg.piece)
  return g.__deriveIn.length
}

/** Decode the figure, draw it within the long side, encode it again in the same format.
 *  Resolves the new size in bytes, or 0 when the result is no smaller. */
const pageEncode = async (job: {
  type: string
  maxSide: number
  quality: number
}): Promise<number> => {
  const g = globalThis as unknown as {
    __deriveIn?: string[]
    __deriveOut?: string
    atob(text: string): string
    btoa(text: string): string
    Blob: new (parts: unknown[], options: { type: string }) => unknown
    createImageBitmap(
      source: unknown,
      options: { imageOrientation: string },
    ): Promise<{ width: number; height: number; close(): void }>
    OffscreenCanvas: new (
      width: number,
      height: number,
    ) => {
      getContext(kind: "2d"): {
        drawImage(image: unknown, x: number, y: number, width: number, height: number): void
      } | null
      convertToBlob(options: {
        type: string
        quality: number
      }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
    }
  }
  const binary = g.atob((g.__deriveIn ?? []).join(""))
  g.__deriveIn = []
  const input = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) input[i] = binary.charCodeAt(i)
  const bitmap = await g.createImageBitmap(new g.Blob([input], { type: job.type }), {
    imageOrientation: "from-image",
  })
  const scale = Math.min(1, job.maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new g.OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (!context) return 0
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: job.type, quality: job.quality / 100 })
  const output = new Uint8Array(await blob.arrayBuffer())
  if (output.byteLength >= input.byteLength) return 0
  let text = ""
  for (let at = 0; at < output.byteLength; at += 0x8000)
    text += String.fromCharCode(...output.subarray(at, at + 0x8000))
  g.__deriveOut = g.btoa(text)
  return output.byteLength
}

/** One slice of the encoded result, as base64. */
const pageSend = (range: { at: number; length: number }): string => {
  const g = globalThis as unknown as { __deriveOut?: string }
  return (g.__deriveOut ?? "").slice(range.at, range.at + range.length)
}

// -------------------------------------------------------------------------------------

const TIMED_OUT = Symbol("timed out")

export const browserFigureShrinker = (
  binding: BrowserWorker,
  launch: (binding: BrowserWorker) => Promise<ShrinkBrowser> = (b) =>
    puppeteer.launch(b, { keep_alive: KEEP_ALIVE_MS }) as unknown as Promise<ShrinkBrowser>,
): BrowserShrinker => {
  let browser: Promise<ShrinkBrowser> | null = null
  let page: ShrinkPage | null = null
  let unavailable = false
  // One figure at a time through the one page: slices of two figures must never interleave.
  let queue: Promise<unknown> = Promise.resolve()

  const pageFor = async (): Promise<ShrinkPage> => {
    browser ??= launch(binding)
    try {
      page ??= await (await browser).newPage()
    } catch (error) {
      unavailable = true
      throw error
    }
    return page
  }
  const dropPage = async (): Promise<void> => {
    const stale = page
    page = null
    await stale?.close().catch(() => undefined)
  }

  const run = async (input: FigureShrinkInput): Promise<Uint8Array | null> => {
    const type = MIME[/\.([a-z0-9]+)$/i.exec(input.path)?.[1]?.toLowerCase() ?? ""]
    if (!type) return null
    const size = imageDimensions(input.bytes)
    if (!size || size.width * size.height > MAX_INPUT_PIXELS) return null
    const p = await pageFor()
    for (let at = 0; at < input.bytes.byteLength; at += SLICE_BYTES)
      await p.evaluate(pageReceive, {
        piece: toBase64(input.bytes.subarray(at, at + SLICE_BYTES)),
        first: at === 0,
      })
    const length = await p.evaluate(pageEncode, {
      type,
      maxSide: input.maxSide,
      quality: input.quality,
    })
    if (!length) return null
    const out = new Uint8Array(length)
    let filled = 0
    const chars = Math.ceil(length / 3) * 4
    for (let at = 0; at < chars; at += SLICE_CHARS) {
      const binary = atob(await p.evaluate(pageSend, { at, length: SLICE_CHARS }))
      for (let i = 0; i < binary.length && filled < length; i++)
        out[filled++] = binary.charCodeAt(i)
    }
    return filled === length ? out : null
  }

  const shrink: FigureShrinker = (input) => {
    const next = queue.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), PER_FIGURE_MS)
      })
      try {
        const result = await Promise.race([run(input).catch(() => null), late])
        if (result !== TIMED_OUT) return result
        // The page may still be busy with it: start the next figure on a fresh one.
        await dropPage()
        return null
      } finally {
        clearTimeout(timer)
      }
    })
    queue = next.catch(() => undefined)
    return next
  }

  return {
    shrink,
    get unavailable() {
      return unavailable
    },
    close: async () => {
      await queue
      await dropPage()
      const opened = browser
      browser = null
      if (opened) await (await opened.catch(() => null))?.close().catch(() => undefined)
    },
  }
}
