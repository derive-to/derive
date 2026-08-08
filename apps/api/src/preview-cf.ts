import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
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
      const buf = (await page.screenshot({ type: "png", fullPage: !!opts.fullPage })) as Uint8Array
      return buf
    } finally {
      await browser.close()
    }
  },
})
