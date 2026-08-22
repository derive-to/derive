import { chromium } from "playwright"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
  type Renderer,
  type ScreenshotOpts,
  sampleRenderLayout,
  waitForRenderQuiescence,
} from "./previews"

/** A Renderer backed by a locally-installed Playwright Chromium. Node self-host only —
 *  never imported by the edge build. Each screenshot runs in a fresh isolated context. */
export const playwrightRenderer = (): Renderer => ({
  screenshot: async (url: string, opts: ScreenshotOpts): Promise<Uint8Array> => {
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
        // Below 1 for the full-page variants: fewer pixels is what bounds the shot.
        ...(opts.deviceScaleFactor ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
      })
      const page = await context.newPage()
      assertNavigationOk(
        await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs }),
        url,
      )
      await waitForRenderQuiescence(
        () => page.evaluate(sampleRenderLayout),
        (ms) => page.waitForTimeout(ms),
        { timeoutMs: Math.min(2_500, Math.max(600, Math.floor(opts.timeoutMs / 5))) },
      )
      assertRenderedDocumentOk(
        await page.evaluate(() => ({
          contentType: document.contentType,
          bodyText: document.body?.innerText ?? "",
        })),
        url,
      )
      const buf = await page.screenshot({ type: "png", fullPage: !!opts.fullPage })
      return new Uint8Array(buf)
    } finally {
      await browser.close()
    }
  },
})
