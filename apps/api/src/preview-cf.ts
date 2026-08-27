import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
  type PdfOpts,
  type Renderer,
  type ScreenshotOpts,
} from "./previews"

type CfPage = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>

const settle = async (page: CfPage, exportMode: boolean): Promise<void> => {
  if (!exportMode) return
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}[data-derive-export-transient],[data-derive-chrome],[role=tooltip]{display:none!important}[data-derive-export-region]{break-inside:avoid!important;page-break-inside:avoid!important}",
  })
  await page.evaluate(async () => {
    const g = globalThis as unknown as {
      document: {
        fonts?: { ready: Promise<unknown> }
        images: ArrayLike<{ complete: boolean; decode(): Promise<void> }>
      }
    }
    await g.document.fonts?.ready
    await Promise.all(
      Array.from(g.document.images).map((img) =>
        img.complete ? Promise.resolve() : img.decode().catch(() => undefined),
      ),
    )
  })
  await page
    .waitForFunction(
      () => {
        const g = globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } }
        }
        return g.document.documentElement.dataset.deriveExportReady === "true"
      },
      { timeout: 3_000 },
    )
    .catch(() => undefined)
}

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
      await settle(page, !!opts.exportMode)
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
      await settle(page, true)
      if (opts.deck)
        await page.addStyleTag({
          content:
            "@page{size:13.333333in 7.5in;margin:0}html,body{width:1280px!important;margin:0!important;padding:0!important;overflow:visible!important}.stage{position:static!important;transform:none!important;width:1280px!important;height:auto!important;overflow:visible!important}.slide,[data-derive-slide]{position:relative!important;inset:auto!important;display:flex!important;opacity:1!important;visibility:visible!important;transform:none!important;width:1280px!important;height:720px!important;page-break-after:always!important;break-after:page!important}.zone,.rail,.count{display:none!important}",
        })
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
      await settle(page, true)
      await page.addStyleTag({
        content:
          "html,body{margin:0!important;width:1280px!important;height:720px!important;overflow:hidden!important}.stage{position:fixed!important;inset:0!important;transform:none!important;width:1280px!important;height:720px!important;border-radius:0!important}.zone,.rail,.count{display:none!important}",
      })
      const count = await page.$$eval("[data-derive-slide], .slide", (nodes) => nodes.length)
      const out: Uint8Array[] = []
      for (let i = 0; i < count; i++) {
        await page.$$eval(
          "[data-derive-slide], .slide",
          (nodes, at) => {
            for (const [n, node] of nodes.entries()) {
              const style = (
                node as unknown as { style: { setProperty(a: string, b: string, c: string): void } }
              ).style
              style.setProperty("opacity", n === at ? "1" : "0", "important")
              style.setProperty("visibility", n === at ? "visible" : "hidden", "important")
              style.setProperty("transform", "none", "important")
            }
          },
          i,
        )
        out.push((await page.screenshot({ type: "png" })) as Uint8Array)
      }
      return out
    } finally {
      await browser.close()
    }
  },
})
