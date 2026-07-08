import { chromium } from "playwright"
import type { Renderer, ScreenshotOpts } from "./previews"

/** A Renderer backed by a locally-installed Playwright Chromium. Node self-host only —
 *  never imported by the edge build. Each screenshot runs in a fresh isolated context. */
export const playwrightRenderer = (): Renderer => ({
  screenshot: async (url: string, opts: ScreenshotOpts): Promise<Uint8Array> => {
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
      })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs })
      const buf = await page.screenshot({ type: "png", fullPage: !!opts.fullPage })
      return new Uint8Array(buf)
    } finally {
      await browser.close()
    }
  },
})
