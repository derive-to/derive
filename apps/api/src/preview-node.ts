import { chromium } from "playwright"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
  type PdfOpts,
  type Renderer,
  type ScreenshotOpts,
} from "./previews"

const settle = async (page: import("playwright").Page, exportMode: boolean): Promise<void> => {
  if (!exportMode) return
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}[data-derive-export-transient],[data-derive-chrome],[role=tooltip]{display:none!important}[data-derive-export-region]{break-inside:avoid!important;page-break-inside:avoid!important}",
  })
  await page.evaluate(async () => {
    await document.fonts?.ready
    await Promise.all(
      [...document.images].map((img) =>
        img.complete ? Promise.resolve() : img.decode().catch(() => undefined),
      ),
    )
  })
  await page
    .waitForFunction(() => document.documentElement.dataset.deriveExportReady === "true", null, {
      timeout: 3_000,
    })
    .catch(() => undefined)
}

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
      await settle(page, !!opts.exportMode)
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
      await settle(page, true)
      if (opts.deck) {
        await page.addStyleTag({
          content:
            "@page{size:13.333333in 7.5in;margin:0}html,body{width:1280px!important;margin:0!important;padding:0!important;overflow:visible!important}.stage{position:static!important;transform:none!important;width:1280px!important;height:auto!important;overflow:visible!important}.slide,[data-derive-slide]{position:relative!important;inset:auto!important;display:flex!important;opacity:1!important;visibility:visible!important;transform:none!important;width:1280px!important;height:720px!important;page-break-after:always!important;break-after:page!important;pointer-events:none!important}.slide:last-child,[data-derive-slide]:last-child{page-break-after:auto!important;break-after:auto!important}.zone,.rail,.count{display:none!important}",
        })
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
      await settle(page, true)
      await page.addStyleTag({
        content:
          "html,body{margin:0!important;width:1280px!important;height:720px!important;overflow:hidden!important}.stage{position:fixed!important;inset:0!important;transform:none!important;width:1280px!important;height:720px!important;border-radius:0!important}.zone,.rail,.count{display:none!important}",
      })
      const slides = page.locator("[data-derive-slide], .slide")
      const count = await slides.count()
      const out: Uint8Array[] = []
      for (let i = 0; i < count; i++) {
        await page.evaluate((at) => {
          const all = [...document.querySelectorAll<HTMLElement>("[data-derive-slide], .slide")]
          all.forEach((slide, n) => {
            slide.style.setProperty("opacity", n === at ? "1" : "0", "important")
            slide.style.setProperty("visibility", n === at ? "visible" : "hidden", "important")
            slide.style.setProperty("transform", "none", "important")
          })
        }, i)
        out.push(new Uint8Array(await page.screenshot({ type: "png" })))
      }
      return out
    } finally {
      await browser.close()
    }
  },
})
