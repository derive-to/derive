import { chromium } from "playwright"
import { prepareDeckPrint } from "./lib/deck-print"
import { prepareDeckCapture, selectDeckSlide, settleExportPage } from "./lib/export-render"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
  type PdfOpts,
  type Renderer,
  type ScreenshotOpts,
} from "./previews"

const open = async (page: import("playwright").Page, url: string, timeoutMs: number) => {
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs })
  assertNavigationOk(res, url)
  assertRenderedDocumentOk(
    await page.evaluate(() => ({
      contentType: document.contentType,
      bodyText: document.body?.innerText ?? "",
    })),
    url,
  )
}

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
        reducedMotion: opts.exportMode ? "reduce" : "no-preference",
      })
      const page = await context.newPage()
      await open(page, url, opts.timeoutMs)
      if (opts.exportMode)
        await settleExportPage(
          (callback, input) => page.evaluate(callback, input),
          (content) => page.addStyleTag({ content }),
        )
      const buf = opts.selector
        ? await page.locator(opts.selector).first().screenshot({ type: "png" })
        : await page.screenshot({ type: "png", fullPage: !!opts.fullPage })
      return new Uint8Array(buf)
    } finally {
      await browser.close()
    }
  },
  pdf: async (url: string, opts: PdfOpts): Promise<Uint8Array> => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await open(page, url, opts.timeoutMs)
      await settleExportPage(
        (callback, input) => page.evaluate(callback, input),
        (content) => page.addStyleTag({ content }),
      )
      if (opts.deck) {
        await prepareDeckPrint(
          (callback, input) => page.evaluate(callback, input),
          (content) => page.addStyleTag({ content }),
        )
      }
      await page.emulateMedia({ media: "print" })
      return new Uint8Array(
        await page.pdf({
          printBackground: true,
          preferCSSPageSize: opts.deck,
          format: opts.deck ? undefined : "A4",
          margin: opts.deck
            ? undefined
            : { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
        }),
      )
    } finally {
      await browser.close()
    }
  },
  deckImages: async (url: string, timeoutMs: number): Promise<Uint8Array[]> => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await open(page, url, timeoutMs)
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
        out.push(new Uint8Array(await page.screenshot({ type: "png" })))
      }
      return out
    } finally {
      await browser.close()
    }
  },
})
