import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer"
import { prepareDeckPrint } from "./lib/deck-print"
import { prepareDeckCapture, selectDeckSlide, settleExportPage } from "./lib/export-render"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
  type PdfOpts,
  type Renderer,
  type ScreenshotOpts,
} from "./previews"

/**
 * A Renderer backed by Cloudflare Browser Rendering. One warm browser per DO
 * instance drains the queue sequentially, so concurrent-browser billing stays at
 * the floor. Each tick launches a fresh browser (correctness-first; warm-reuse is
 * a follow-up optimisation once the deploy verifies).
 */
export const cfBrowserRenderer = (binding: BrowserWorker): Renderer => ({
  screenshot: async (url: string, opts: ScreenshotOpts): Promise<Uint8Array> => {
    const browser = await puppeteer.launch(binding)
    try {
      const page = await browser.newPage()
      await page.setViewport({
        width: opts.width,
        height: opts.height,
        // Mirrors the Node renderer, so the two runtimes cannot disagree about a variant.
        ...(opts.deviceScaleFactor ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
      })
      assertNavigationOk(
        await page.goto(url, { waitUntil: "networkidle0", timeout: opts.timeoutMs }),
        url,
      )
      assertRenderedDocumentOk(
        await page.evaluate(() => {
          // The Worker build intentionally excludes DOM types, but this callback is
          // serialized by Puppeteer and executes inside the browser page.
          const pageGlobal = globalThis as unknown as {
            document: { contentType: string; body?: { innerText: string } | null }
          }
          return {
            contentType: pageGlobal.document.contentType,
            bodyText: pageGlobal.document.body?.innerText ?? "",
          }
        }),
        url,
      )
      if (opts.exportMode)
        await settleExportPage(
          (callback, input) => page.evaluate(callback, input),
          (content) => page.addStyleTag({ content }),
        )
      const buf = opts.selector
        ? ((await (await page.$(opts.selector))?.screenshot({ type: "png" })) as
            | Uint8Array
            | undefined)
        : ((await page.screenshot({ type: "png", fullPage: !!opts.fullPage })) as Uint8Array)
      if (!buf) throw new Error(`export region not found: ${opts.selector}`)
      return buf
    } finally {
      await browser.close()
    }
  },
  pdf: async (url: string, opts: PdfOpts): Promise<Uint8Array> => {
    const browser = await puppeteer.launch(binding)
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1280, height: 720 })
      assertNavigationOk(
        await page.goto(url, { waitUntil: "networkidle0", timeout: opts.timeoutMs }),
        url,
      )
      await settleExportPage(
        (callback, input) => page.evaluate(callback, input),
        (content) => page.addStyleTag({ content }),
      )
      if (opts.deck)
        await prepareDeckPrint(
          (callback, input) => page.evaluate(callback, input),
          (content) => page.addStyleTag({ content }),
        )
      await page.emulateMediaType("print")
      return (await page.pdf({
        printBackground: true,
        preferCSSPageSize: opts.deck,
        format: opts.deck ? undefined : "A4",
      })) as Uint8Array
    } finally {
      await browser.close()
    }
  },
  deckImages: async (url: string, timeoutMs: number): Promise<Uint8Array[]> => {
    const browser = await puppeteer.launch(binding)
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1280, height: 720 })
      assertNavigationOk(
        await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs }),
        url,
      )
      await settleExportPage(
        (callback, input) => page.evaluate(callback, input),
        (content) => page.addStyleTag({ content }),
      )
      const count = await prepareDeckCapture(
        (callback, input) => page.evaluate(callback, input),
        (content) => page.addStyleTag({ content }),
      )
      const out: Uint8Array[] = []
      for (let i = 0; i < count; i++) {
        await selectDeckSlide((callback, input) => page.evaluate(callback, input), i)
        out.push((await page.screenshot({ type: "png" })) as Uint8Array)
      }
      return out
    } finally {
      await browser.close()
    }
  },
})
